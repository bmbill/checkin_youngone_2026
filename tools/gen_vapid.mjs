/**
 * 產生一對 Web Push（VAPID）金鑰。
 *
 *   node tools/gen_vapid.mjs
 *
 * 公鑰 → leave/config.js 的 vapidPublicKey（可以公開，會進 git）
 * 私鑰 → Supabase 後台 Edge Functions 的 Secrets：VAPID_PRIVATE_KEY
 *        ★ 私鑰絕對不要貼進任何檔案，這個 repo 是公開的 ★
 *
 * 兩把必須是同一對。換一把就等於把所有人的推播訂閱作廢，
 * 每支手機都要重新按一次「開啟推播」—— 營期期間不要重跑這支。
 */
import { webcrypto as crypto } from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');

const kp = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const pub = await crypto.subtle.exportKey('raw', kp.publicKey);   // 65 bytes: 0x04 || X || Y
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

console.log('');
console.log('VAPID 公鑰（貼進 leave/config.js 的 vapidPublicKey）');
console.log('  ' + b64u(pub));
console.log('');
console.log('VAPID 私鑰（貼進 Supabase Secrets 的 VAPID_PRIVATE_KEY，不要進 git）');
console.log('  ' + jwk.d);
console.log('');
console.log('另外還要設一個 VAPID_SUBJECT，值填 mailto:你的信箱');
console.log('（推播服務要求要留聯絡方式，出問題時他們才知道找誰）');
console.log('');
