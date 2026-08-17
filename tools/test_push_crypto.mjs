/**
 * 驗證推播加密（supabase/functions/push/index.ts）真的寫對了。
 *
 *   node tools/test_push_crypto.mjs
 *
 * 為什麼需要這支：Web Push 的加密（RFC 8291）寫錯的話，
 * 推播服務只會回一句 400 BadRequest，不會告訴你哪一步錯了。
 * 而且要有真的手機訂閱才測得到 —— 營期當天才發現就來不及了。
 *
 * 這裡直接載入那支 Edge Function 的**真實程式碼**（不是複製一份），
 * 自己扮演「手機」那一端：產生一對訂閱金鑰、請它加密、再照規範解回來。
 * 解得出原文，就表示 ECDH、兩段 HKDF、AES-GCM、標頭組裝全部正確。
 */
import { webcrypto as crypto } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const cat  = (...a) => Buffer.concat(a.map(x => Buffer.from(x)));
const utf8 = s => Buffer.from(s, 'utf8');

/* ── 先產一對 VAPID 金鑰餵給那支程式 ── */
const vapid = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidPub  = await crypto.subtle.exportKey('raw', vapid.publicKey);
const vapidJwk  = await crypto.subtle.exportKey('jwk', vapid.privateKey);

process.env.VAPID_PUBLIC_KEY  = b64u(vapidPub);
process.env.VAPID_PRIVATE_KEY = vapidJwk.d;
process.env.VAPID_SUBJECT     = 'mailto:test@example.org';
process.env.SUPABASE_URL      = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';

// 那支程式跑在 Deno 上。這裡補兩個最小的替身，讓它能在 node 裡被載入。
globalThis.Deno = { env: { get: k => process.env[k] }, serve: () => {} };

const push = await import('../supabase/functions/push/index.ts');

let fail = 0;
const ok  = (name, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '　' + extra : ''));
  if (!cond) fail++;
};

/* ══════════ 1. VAPID 憑證 ══════════ */
console.log('\nVAPID 憑證（RFC 8292）');
{
  const header = await push.vapidHeader('https://web.push.apple.com/abc123');
  const m = header.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/);
  ok('Authorization 標頭格式正確', !!m);

  if (m) {
    const [head, body, sig] = m[1].split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    ok('aud 是推播伺服器的 origin', claims.aud === 'https://web.push.apple.com', claims.aud);
    ok('sub 有帶聯絡方式',        claims.sub === 'mailto:test@example.org');
    ok('exp 在 24 小時內（規範上限）',
       claims.exp - Math.floor(Date.now() / 1000) <= 86400);
    ok('k 帶的是公鑰',            m[2] === b64u(vapidPub));

    // 用公鑰驗簽 —— 這一步失敗就表示私鑰／公鑰組錯對，推播服務會回 401
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, vapid.publicKey,
      Buffer.from(sig, 'base64url'), utf8(`${head}.${body}`));
    ok('簽章驗得過（公私鑰是同一對）', valid);
  }
}

/* ══════════ 2. 內容加密 ══════════ */
console.log('\n內容加密（RFC 8291 aes128gcm）');
{
  // 扮演手機：訂閱時瀏覽器產生的那一對金鑰 + 16 bytes 的 auth secret
  const ua = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub  = Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const payload = JSON.stringify({
    title: '有新的請假單待簽核',
    body:  '第03組 王小明　08/22 14:00 → 08/22 18:00（看牙醫）'
  });

  const body = Buffer.from(
    await push.encrypt(b64u(uaPub), b64u(authSecret), payload));

  /* ── 照規範拆標頭 ── */
  const salt   = body.subarray(0, 16);
  const rs     = body.readUInt32BE(16);
  const idlen  = body[20];
  const ephPub = body.subarray(21, 21 + idlen);
  const ct     = body.subarray(21 + idlen);

  ok('salt 是 16 bytes',        salt.length === 16);
  ok('記錄大小 >= 明文長度+17', rs >= Buffer.byteLength(payload) + 17, String(rs));
  ok('臨時公鑰是 65 bytes 未壓縮格式', idlen === 65 && ephPub[0] === 0x04);
  ok('密文 = 明文+1 分隔符+16 GCM tag',
     ct.length === Buffer.byteLength(payload) + 1 + 16, String(ct.length));

  /* ── 手機端解密 ── */
  const ephKey = await crypto.subtle.importKey(
    'raw', ephPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephKey }, ua.privateKey, 256);

  const sharedKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret,
      info: cat(utf8('WebPush: info'), Buffer.from([0]), uaPub, ephPub) }, sharedKey, 256);

  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: cat(utf8('Content-Encoding: aes128gcm'), Buffer.from([0])) }, ikmKey, 128);
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: cat(utf8('Content-Encoding: nonce'), Buffer.from([0])) }, ikmKey, 96);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  let plain = null;
  try {
    plain = Buffer.from(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(nonce) }, aes, ct));
  } catch (e) {
    ok('AES-GCM 解得開', false, String(e.message));
  }

  if (plain) {
    ok('最後一個 byte 是分隔符 0x02', plain[plain.length - 1] === 0x02);
    const text = plain.subarray(0, plain.length - 1).toString('utf8');
    ok('解出來和原文一模一樣', text === payload);
    if (text === payload) {
      console.log('\n  手機上會看到：');
      const n = JSON.parse(text);
      console.log('    ' + n.title);
      console.log('    ' + n.body);
    }
  }

  /* ── 換一把金鑰就該解不開（確認不是把明文直接送出去） ── */
  const other = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const otherShared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephKey }, other.privateKey, 256);
  ok('用別人的金鑰導不出同一組祕密',
     Buffer.from(otherShared).toString('hex') !== Buffer.from(shared).toString('hex'));
}

/* ══════════ 3. 每次加密都要用新的臨時金鑰 ══════════ */
console.log('\n重放保護');
{
  const ua = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth  = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const a = Buffer.from(await push.encrypt(b64u(uaPub), auth, 'hello'));
  const b = Buffer.from(await push.encrypt(b64u(uaPub), auth, 'hello'));
  ok('同樣的內容送兩次，密文不同（salt 和臨時金鑰都換了）', !a.equals(b));
}

console.log(fail ? `\n✗ ${fail} 項失敗\n` : '\n✓ 全部通過\n');
process.exit(fail ? 1 : 0);
