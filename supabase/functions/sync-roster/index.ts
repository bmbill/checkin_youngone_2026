/**
 * 2026 卓青營 請假系統 —— 同步學員名單 (Supabase Edge Function)
 *
 * 名單的唯一來源永遠是報到那份 Google 試算表。這支程式只做一件事：
 * 去報到系統的 API 讀一份「組別／姓名／預排房號／錄取編號」，寫進 lv_students。
 *
 *   · 唯讀。從頭到尾沒有任何寫回試算表的動作 —— 報到台正在用那份活資料。
 *   · 讀名單的通行碼放在這裡的 Secrets，不在前端。前端是公開的靜態檔，
 *     通行碼寫進去等於把報到名單公開。
 *
 * 需要的環境變數（Supabase 後台 → Edge Functions → Secrets）：
 *   ROSTER_API_URL  報到系統 Apps Script 的部署網址（就是 index.html 裡那個 API_URL）
 *   ROSTER_TOKEN    Api.gs 裡新增的 LEAVE_TOKEN（唯讀，只能呼叫 getRoster）
 *
 * 呼叫方式：POST { code: '行政中心或關懷員的通行碼' }
 */

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GAS_URL   = Deno.env.get('ROSTER_API_URL') ?? '';
const GAS_TOKEN = Deno.env.get('ROSTER_TOKEN')   ?? '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type Row = { sid: string; grp: string; name: string; room: string };

async function sb(path: string, init: RequestInit) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  if (!res.ok) {
    // PostgREST 把 raise exception 包成 JSON，直接丟原文使用者只會看到一堆欄位名
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).message || msg; } catch { /* 原文就好 */ }
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    if (!GAS_URL || !GAS_TOKEN) {
      return json({ error: '還沒設定 ROSTER_API_URL / ROSTER_TOKEN' }, 400);
    }
    const { code } = await req.json().catch(() => ({ code: '' }));

    // 誰能按這顆同步鈕：行政中心和關懷員。驗通行碼一律回到資料庫做。
    const who = await sb('rpc/lv_who', {
      method: 'POST', body: JSON.stringify({ p_code: code })
    }) as { role: string; label: string };
    if (!['admin', 'care'].includes(who.role)) {
      return json({ error: `「${who.label}」不能同步名單` }, 403);
    }

    const url = `${GAS_URL}?api=1&action=getRoster&token=${encodeURIComponent(GAS_TOKEN)}`;
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    let data: { roster?: Row[]; error?: string; message?: string };
    try { data = JSON.parse(text); } catch {
      // Apps Script 出錯時會回一整頁 HTML，直接丟原文只會看到一堆標籤
      throw new Error(`報到系統回的不是 JSON（可能是網址錯了或沒重新部署）：${text.slice(0, 200)}`);
    }
    if (data.error) throw new Error(`報到系統：${data.message || data.error}`);

    const rows = (data.roster ?? [])
      .map(r => ({
        sid:  String(r.sid ?? '').trim(),
        grp:  String(r.grp ?? '').trim(),
        name: String(r.name ?? '').trim(),
        room: String(r.room ?? '').trim()
      }))
      .filter(r => r.sid && r.name);   // 沒有錄取編號的列沒辦法當主鍵，跳過

    if (!rows.length) throw new Error('報到名單回來是空的，沒有動任何資料');

    await sb('lv_students?on_conflict=sid', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() })))
    });

    /* 名單上被移除的人（沒來、取消報名）要跟著清掉，否則填單的下拉選單裡
       會一直留著不存在的人。但只在這次抓回來的資料「看起來完整」時才清 ——
       萬一哪次只讀到三筆就把整張表洗掉，現場會直接無法填單。 */
    let removed = 0;
    if (rows.length >= 20) {
      const keep = rows.map(r => `"${r.sid}"`).join(',');
      const gone = await sb(`lv_students?sid=not.in.(${keep})`, {
        method: 'DELETE', headers: { 'Prefer': 'return=representation' }
      }) as Row[];
      removed = gone?.length ?? 0;
    }

    return json({ ok: true, count: rows.length, removed, by: who.label });

  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 200);
  }
});
