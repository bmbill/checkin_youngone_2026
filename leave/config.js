/**
 * 2026 卓青營 請假系統 —— 前端設定
 *
 * 這個檔案會公開在網路上（GitHub Pages）。下面三個值都是「設計上可以公開」的：
 *
 *   url            Supabase 專案網址
 *   anonKey        匿名金鑰。它本身什麼權限都沒有 —— 資料庫裡每一張表對
 *                  anon 都是零權限，能呼叫的只有 12 支 lv_* 函式，而每一支
 *                  的第一行都是驗通行碼。沒有通行碼，拿著這把金鑰什麼都做不到。
 *   vapidPublicKey 推播的公鑰。私鑰只放在 Supabase 的 Secrets 裡，永遠不進 git。
 *
 * ★ 四組身分通行碼不在這裡，也不在任何檔案裡 ★
 *   它們只以 bcrypt 雜湊的形式存在資料庫。設定方式見 leave/README.md。
 *
 * 填法見 leave/README.md 步驟 2。
 */
window.CFG = {
  url:     'https://qkakfiyyyibcyvzbxhhd.supabase.co',
  // 新版金鑰格式（sb_publishable_…）。後台 → Project Settings → API → Publishable key
  anonKey: 'sb_publishable_1E6KWGtQMKU3CSTLFFj2RA_ZlYXQ-Gf',

  // tools/gen_vapid.mjs 產生的公鑰。留空 = 推播停用，系統改用「頁面開著＋響鈴」通知
  vapidPublicKey: 'BGfOIyW2-LxWqEQ52ktb9kt8JYVqawsjIKCGKgFdV30GotxtU2YmAgceIZb8EhJzqI-qBwPgXYW9OKXh7CTqfs0',

  // 即時訂閱（新單當場跳出來）。設 false 就只用輪詢，慢 8 秒但更省電
  realtime: true
};
