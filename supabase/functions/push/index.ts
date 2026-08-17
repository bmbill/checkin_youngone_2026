/**
 * 2026 卓青營 請假系統 —— 推播發送 (Supabase Edge Function)
 *
 * 為什麼要有這一支：手機把頁面關掉、或螢幕鎖起來之後，頁面裡的 JavaScript
 * 就停了。要在鎖屏收到「有新的請假單待簽核」，只有 Web Push 這條路，
 * 而 Web Push 的憑證必須用 ES256（橢圓曲線）簽 —— 那要一台伺服器。
 *
 * 這裡自己實作 VAPID（RFC 8292）和內容加密（RFC 8291），沒有用任何套件：
 *   · WebCrypto 在 Deno 裡是完整的，ECDSA／ECDH／HKDF／AES-GCM 都有
 *   · 少一個 npm 依賴，就少一次「營期前一天套件更新把系統弄壞」
 *
 * 內容是端到端加密的：Apple／Google 的推播伺服器只看得到一包亂碼，
 * 解得開的只有訂閱的那支手機。所以通知內容可以放學員姓名。
 *
 * 需要的環境變數（Supabase 後台 → Edge Functions → Secrets）：
 *   VAPID_PUBLIC_KEY   base64url，和前端 leave/config.js 裡那把是同一把
 *   VAPID_PRIVATE_KEY  base64url，只放在這裡，絕對不要進 git
 *   VAPID_SUBJECT      mailto:你的信箱（推播服務要求要有聯絡方式）
 * SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 由平台自動注入，不用自己設。
 *
 * 呼叫方式（前端做完一個動作就打一次）：
 *   POST { code: '通行碼', event: 'new'|'approved'|'rejected'|'closed', no: 'L0007' }
 *   POST { mode: 'overdue' }        ← 逾時未回營巡邏，給排程用
 */

const SB_URL   = Deno.env.get('SUPABASE_URL')!;
const SB_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUB      = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
const PRIV     = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const SUBJECT  = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:camp@example.org';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/* ══════════ base64url ══════════ */

export function b64uToBytes(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array | ArrayBuffer): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/* ══════════ VAPID：證明「這則推播是我們發的」 ══════════ */

/**
 * VAPID 私鑰在檔案裡是 32 bytes 的 d 值，WebCrypto 要 JWK 格式，
 * 而 JWK 需要 x／y —— 那兩個就藏在公鑰的 65 bytes 裡（0x04 || X || Y）。
 * 所以私鑰和公鑰必須是同一對，否則簽出來的憑證會被推播服務打回。
 */
async function vapidKey(): Promise<CryptoKey> {
  const pub = b64uToBytes(PUB);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY 不是 65 bytes 的未壓縮 P-256 公鑰，請用 tools/gen_vapid.mjs 重新產生');
  }
  return await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256', ext: true,
      d: PRIV,
      x: bytesToB64u(pub.slice(1, 33)),
      y: bytesToB64u(pub.slice(33, 65))
    },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
}

const jwtCache = new Map<string, { jwt: string; exp: number }>();

export async function vapidHeader(endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  // 憑證有效 12 小時，同一輪要送二十支手機時不必簽二十次
  if (hit && hit.exp - now > 600) return `vapid t=${hit.jwt}, k=${PUB}`;

  const exp = now + 12 * 3600;
  const head = bytesToB64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(utf8(JSON.stringify({ aud, exp, sub: SUBJECT })));
  const data = utf8(`${head}.${body}`);
  // WebCrypto 的 ECDSA 簽章就是 r||s 原始格式，正好是 JWS 要的，不用轉 DER
  const sig  = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(), data);
  const jwt  = `${head}.${body}.${bytesToB64u(sig)}`;
  jwtCache.set(aud, { jwt, exp });
  return `vapid t=${jwt}, k=${PUB}`;
}

/* ══════════ 內容加密（RFC 8291 aes128gcm） ══════════ */

export async function encrypt(p256dh: string, auth: string, payload: string): Promise<Uint8Array> {
  const ua   = b64uToBytes(p256dh);   // 手機的公鑰 65 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 每一則推播都用一把新的臨時金鑰，這是 RFC 的要求
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const uaKey  = await crypto.subtle.importKey(
    'raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, eph.privateKey, 256);

  // 第一次 HKDF：把 ECDH 共享祕密和手機的 auth secret 揉成 IKM
  const sharedKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyInfo   = cat(utf8('WebPush: info'), new Uint8Array([0]), ua, ephPub);
  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: b64uToBytes(auth), info: keyInfo }, sharedKey, 256);

  // 第二次 HKDF：從 IKM 導出真正的內容金鑰和 nonce
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: cat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])) }, ikmKey, 128);
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt,
      info: cat(utf8('Content-Encoding: nonce'), new Uint8Array([0])) }, ikmKey, 96);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 是「這是最後一段、後面沒有填充」的分隔符號
  const plain = cat(utf8(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce) }, aes, plain));

  // 標頭：salt(16) + 記錄大小(4) + 公鑰長度(1) + 臨時公鑰(65) + 密文
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([ephPub.length]), ephPub, ct);
}

/* ══════════ 送出 ══════════ */

type Target = { endpoint: string; p256dh: string; auth: string };

async function sendOne(t: Target, payload: string) {
  const body = await encrypt(t.p256dh, t.auth, payload);
  const res = await fetch(t.endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    await vapidHeader(t.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type':     'application/octet-stream',
      'TTL':              '3600',
      // 簽核是等人的事，不要被系統延後投遞
      'Urgency':          'high'
    },
    body
  });
  /* 404／410 = 這個訂閱永久沒了（使用者清掉網站資料、刪掉主畫面圖示、
     或關掉通知）。標記成失效，下次不用再花時間送。
     其他錯誤（429 太頻繁、5xx 對方掛了）不標失效，只記下來。 */
  return {
    ok:   res.status >= 200 && res.status < 300,
    dead: res.status === 404 || res.status === 410,
    info: `${res.status} ${(await res.text()).slice(0, 120)}`
  };
}

/* ══════════ 資料庫 ══════════ */

async function rpc(fn: string, args: unknown) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* 原文就好 */ }
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

/* ══════════ 一輪推播 ══════════ */

async function blast(job: {
  event: string; title: string; body: string; roles: string[];
  url: string; targets: Target[];
}) {
  const payload = JSON.stringify({
    title: job.title, body: job.body, url: job.url, event: job.event
  });

  // 二十支手機併發送出，整輪一秒內結束
  const results = await Promise.all(job.targets.map(async t => {
    try { return { t, ...(await sendOne(t, payload)) }; }
    catch (e) { return { t, ok: false, dead: false, info: String((e as Error).message) }; }
  }));

  const okEndpoints   = results.filter(r => r.ok).map(r => r.t.endpoint);
  const deadEndpoints = results.filter(r => r.dead).map(r => r.t.endpoint);
  const detail = results.filter(r => !r.ok)
    .map(r => `${new URL(r.t.endpoint).host}: ${r.info}`).join(' | ').slice(0, 900);

  await rpc('lv_push_finish', {
    p: {
      event: job.event, title: job.title, body: job.body, roles: job.roles,
      sent: okEndpoints.length, failed: results.length - okEndpoints.length,
      detail: detail || null, okEndpoints, deadEndpoints
    }
  });

  return { sent: okEndpoints.length, failed: results.length - okEndpoints.length, detail };
}

/* ══════════ 入口 ══════════ */

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    if (!PUB || !PRIV) {
      return json({ error: '還沒設定 VAPID 金鑰，推播停用（其他功能不受影響）' }, 200);
    }
    const p = await req.json().catch(() => ({}));

    /* 逾時未回營巡邏。給排程用，不需要通行碼 —— 它不吃任何外部輸入，
       也不會洩漏任何東西，最多就是被人多叫幾次，而每張單只會提醒一次。 */
    if (p.mode === 'overdue') {
      // lv_overdue_jobs 已經把「標記為提醒過」和「要送什麼給誰」一次做完
      const jobs = await rpc('lv_overdue_jobs', {}) as Array<Parameters<typeof blast>[0]>;
      let sent = 0;
      for (const job of jobs) {
        if (!job.targets?.length) continue;
        sent += (await blast(job)).sent;
      }
      return json({ ok: true, overdue: jobs.length, sent });
    }

    if (!p.code || !p.event || !p.no) {
      return json({ error: '缺少 code / event / no' }, 400);
    }

    const job = await rpc('lv_push_prepare',
      { p_code: p.code, p_event: p.event, p_no: p.no }) as any;
    if (job?.skip)          return json({ ok: true, skipped: '單子狀態跟事件不合，沒有發送' });
    if (!job?.targets?.length) return json({ ok: true, sent: 0, note: '目前沒有任何手機開啟推播' });

    return json({ ok: true, ...(await blast(job)) });

  } catch (e) {
    // 推播失敗絕不能讓前端以為請假單沒送出去 —— 一律回 200，錯誤放在 body 裡
    return json({ error: String((e as Error).message || e) }, 200);
  }
});
