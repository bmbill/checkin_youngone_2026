/* ═══════════════════════════════════════════════════════════════════════
   2026 卓青營 —— 學員請假／銷假系統　資料庫結構 (v1)

   用法：Supabase 後台 → SQL Editor → 貼上整份 → Run。
        可以重複執行，不會弄掉已經有的資料。

   設計原則
   ────────
   1. 前端拿到的 anon key 是公開的（寫在 leave/index.html 裡），所以
      **anon 對每一張表都沒有任何讀寫權限**。所有操作都只能透過下面
      這些 lv_* 函式，而每一支函式的第一件事都是驗通行碼。
      擋在資料庫層而不是前端 —— 前端是公開的靜態檔，誰都能自己組請求。

   2. 通行碼存 bcrypt 雜湊，不存明碼。就算整個資料庫被倒出來，
      也還原不出通行碼。

   3. 狀態轉換一律寫成「update … where status = 目前該有的狀態」，
      再看有沒有更新到列。兩位大組長同時按下同意，第二位一定會落空，
      而且我們讀出現況告訴他是誰先簽的 —— 不需要任何鎖。
   ═══════════════════════════════════════════════════════════════════════ */

create extension if not exists pgcrypto with schema extensions;


/* ══════════ 通行碼 ══════════ */

create table if not exists lv_codes (
  role  text primary key check (role in ('care', 'lead', 'deputy', 'admin')),
  label text not null,
  hash  text not null
);
alter table lv_codes enable row level security;   -- 沒寫任何 policy = 除了 service_role 誰都碰不到
revoke all on lv_codes from anon, authenticated;

/**
 * 設定／修改通行碼。只能在 SQL Editor 裡跑（anon 沒有執行權限）。
 *   select lv_set_code('care',   '關懷員',   'xxxx');
 *   select lv_set_code('lead',   '大組長',   'xxxx');
 *   select lv_set_code('deputy', '副大組長', 'xxxx');
 *   select lv_set_code('admin',  '行政中心', 'xxxx');
 */
create or replace function lv_set_code(p_role text, p_label text, p_code text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_code, '')) < 4 then
    raise exception '通行碼太短，至少 4 個字';
  end if;
  insert into lv_codes (role, label, hash)
  values (p_role, p_label, extensions.crypt(p_code, extensions.gen_salt('bf')))
  on conflict (role) do update set label = excluded.label, hash = excluded.hash;
  return p_label || ' 的通行碼已設定';
end $$;
revoke all on function lv_set_code(text, text, text) from public, anon, authenticated;

/* 通行碼 → 角色。四筆資料就四次 bcrypt 比對，幾毫秒的事。 */
create or replace function lv_who(p_code text)
returns lv_codes
language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes;
begin
  if coalesce(p_code, '') = '' then raise exception '請輸入通行碼'; end if;
  select * into r from lv_codes where hash = extensions.crypt(p_code, hash) limit 1;
  if r.role is null then raise exception '通行碼錯誤'; end if;
  return r;
end $$;

/* 角色不對就擋在這裡。錯誤訊息要講清楚是「誰」不能做「什麼」，
   不然現場只會看到一句「操作失敗」，沒人知道是拿錯通行碼還是系統壞了。 */
create or replace function lv_need(r lv_codes, p_roles text[], p_what text)
returns void language plpgsql immutable as $$
begin
  if not (r.role = any(p_roles)) then
    raise exception '「%」不能%', r.label, p_what;
  end if;
end $$;


/* ══════════ 學員名單（從報到試算表同步過來，這裡只是一份副本） ══════════ */

create table if not exists lv_students (
  sid        text primary key,          -- 錄取編號 TP0101
  grp        text not null default '',  -- 組別
  name       text not null,
  room       text not null default '',  -- 預排房號
  updated_at timestamptz not null default now()
);
alter table lv_students enable row level security;
revoke all on lv_students from anon, authenticated;


/* ══════════ 請假單 ══════════ */

create sequence if not exists lv_no_seq;

create table if not exists lv_leaves (
  no               text primary key,      -- L0001
  status           text not null check (status in ('等待簽核','請假中','完成銷假','已退回','已取消')),
  sid              text not null default '',
  grp              text not null default '',
  name             text not null,
  phone            text not null default '',   -- 學員手機，名單上沒有，關懷員當場手打
  room             text not null default '',
  reason           text not null default '',
  out_at           timestamptz not null,
  due_at           timestamptz not null,
  back_at          timestamptz,
  care             text not null,
  care_phone       text not null default '',
  approver         text,
  approver_role    text,
  approved_at      timestamptz,
  reject_reason    text,
  overdue_notified boolean not null default false,
  log              jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
/* 作廢原因跟退回原因分開兩欄。共用一欄的話，畫面上分不出
   「大組長不同意」和「行政中心把誤開的單收掉」—— 那是兩件完全不同的事。 */
alter table lv_leaves add column if not exists void_reason text;

alter table lv_leaves enable row level security;
revoke all on lv_leaves from anon, authenticated;
create index if not exists lv_leaves_status_idx on lv_leaves (status);
create index if not exists lv_leaves_updated_idx on lv_leaves (updated_at desc);

/* 給行政中心在後台 Table Editor 直接看的：時間換成台北時間、欄名中文。
   後台預設用 UTC 顯示 timestamptz，直接看 lv_leaves 會整批差 8 小時。 */
create or replace view "lv_單子" as
select
  no as "單號", status as "狀態", grp as "組別", name as "學員姓名",
  phone as "行動電話", room as "房號", reason as "事由",
  to_char(out_at  at time zone 'Asia/Taipei', 'MM/DD HH24:MI') as "外出時間",
  to_char(due_at  at time zone 'Asia/Taipei', 'MM/DD HH24:MI') as "預計回來",
  to_char(back_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI') as "實際回來",
  care as "關懷員", care_phone as "關懷員電話",
  approver as "簽核人", approver_role as "簽核身分",
  to_char(approved_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI') as "簽核時間",
  reject_reason as "退回原因", void_reason as "作廢原因",
  to_char(created_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI') as "建立時間",
  log as "紀錄"
from lv_leaves
order by created_at desc;
revoke all on "lv_單子" from anon, authenticated;


/* ══════════ 推播裝置 ══════════ */

create table if not exists lv_devices (
  endpoint   text primary key,           -- 瀏覽器給的推播網址，就是這支手機的身分
  p256dh     text not null,              -- 加密用公鑰
  auth       text not null,              -- 加密用密鑰
  role       text not null,
  person     text not null default '',
  dead       boolean not null default false,
  last_ok    timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table lv_devices enable row level security;
revoke all on lv_devices from anon, authenticated;

/* 推播送出紀錄。留著是為了回答營期現場最常見的那句
   「我明明開了通知，為什麼沒收到？」—— 有沒有送、送到幾支、錯在哪，這裡看得到。 */
create table if not exists lv_pushlog (
  id         bigserial primary key,
  event      text not null,
  title      text not null,
  body       text not null,
  roles      text[] not null,
  sent       int not null default 0,
  failed     int not null default 0,
  detail     text,
  created_at timestamptz not null default now()
);
alter table lv_pushlog enable row level security;
revoke all on lv_pushlog from anon, authenticated;


/* ══════════ 共用小工具 ══════════ */

/* 回給前端的單子長什麼樣。時間一律給 ISO 字串，讓手機自己換成當地時間 ——
   在資料庫裡拼時間字串，只要專案時區跟台北不一樣就會整批錯掉。 */
create or replace function lv_json(l lv_leaves)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'no', l.no, 'status', l.status, 'grp', l.grp, 'name', l.name, 'sid', l.sid,
    'phone', l.phone, 'room', l.room, 'reason', l.reason,
    'out', l.out_at, 'due', l.due_at, 'back', l.back_at,
    'care', l.care, 'carePhone', l.care_phone,
    'approver', l.approver, 'approverRole', l.approver_role, 'approvedAt', l.approved_at,
    'rejectReason', l.reject_reason, 'voidReason', l.void_reason, 'log', l.log,
    'createdAt', l.created_at, 'updatedAt', l.updated_at)
$$;

/* 紀錄欄：一筆一行「誰、幾點、做了什麼」，只增不改。
   之後要追「這張單到底經過誰的手」，全部在這裡。 */
create or replace function lv_log(p_log jsonb, p_who text, p_role text, p_what text)
returns jsonb language sql stable as $$
  select coalesce(p_log, '[]'::jsonb) || jsonb_build_object(
    'at',   to_char(now() at time zone 'Asia/Taipei', 'MM/DD HH24:MI'),
    'who',  p_who, 'role', p_role, 'what', p_what)
$$;

/* rev = 最後更新時間 + 單數。時間相同但有人新增單子也認得出來，
   前端就是靠這個字串決定要不要重新抓整份清單。 */
create or replace function lv_rev()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(max(updated_at)::text, '-') || '/' || count(*)::text from lv_leaves
$$;

/**
 * 關懷員只看得到「自己這個名字」開出來的單。
 *
 * p_care 給 null = 全部（大組長、副大組長、行政中心）。
 * 給名字 = 只有 care 等於這個名字的單。
 *
 * 這個過濾一定要做在資料庫，不能只在前端少顯示幾張 ——
 * 前端過濾的話，每支關懷員的手機還是把全體學員的姓名和電話下載了一份。
 * 擋在這裡，那支手機就真的只拿到自己那幾張單。
 */
create or replace function lv_all_json(p_care text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(lv_json(l) order by l.created_at desc), '[]'::jsonb)
    from lv_leaves l
   where p_care is null or l.care = p_care
$$;

/**
 * 這個身分該看到誰的單。
 *
 * 關懷員 → 只有他登入時打的那個名字；其他角色 → 全部。
 * 名字是手打的，所以打法不一樣就會看不到自己先前開的單 ——
 * 這是「不發清單、維持手打」必然的代價，前端會把這件事寫在畫面上提醒。
 */
create or replace function lv_scope(r lv_codes, p_op text)
returns text language plpgsql immutable as $$
begin
  if r.role <> 'care' then return null; end if;
  if btrim(coalesce(p_op, '')) = '' then
    raise exception '請先填你的名字，關懷員是靠名字認自己的單子的';
  end if;
  return btrim(p_op);
end $$;

/* 時間一律由前端送 ISO 字串（含 +08:00 時區）過來。
   缺時區的字串會被當成資料庫時區解讀，那就會整批差八小時。 */
create or replace function lv_ts(p jsonb, p_key text, p_label text)
returns timestamptz language plpgsql stable as $$
declare s text; t timestamptz;
begin
  s := p ->> p_key;
  if coalesce(s, '') = '' then raise exception '請填%', p_label; end if;
  begin t := s::timestamptz; exception when others then
    raise exception '%的格式看不懂：%', p_label, s;
  end;
  return t;
end $$;


/* ══════════ 讀取 ══════════ */

/* 這三支加了「你是誰」這個參數，舊的單參數版本一定要砍掉。
   留著的話它們還掛在 anon 的開放清單上，關懷員照樣叫得到「回傳全部單子」那一版，
   等於這整個區隔完全沒有效果。 */
drop function if exists lv_bootstrap(text);
drop function if exists lv_leaves_get(text);
drop function if exists lv_poll(text);
drop function if exists lv_all_json();

create or replace function lv_bootstrap(p_code text, p_op text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; j jsonb; v_scope text;
begin
  r := lv_who(p_code);
  v_scope := lv_scope(r, p_op);
  j := jsonb_build_object(
    'role', r.role, 'label', r.label, 'scope', v_scope,
    'leaves', lv_all_json(v_scope), 'rev', lv_rev(), 'serverTime', now());
  -- 學員名單只有關懷員需要（他要填單）。其他角色拿不到，少一份個資在手機上。
  if r.role = 'care' then
    j := j || jsonb_build_object('students', coalesce(
      (select jsonb_agg(jsonb_build_object('sid', sid, 'grp', grp, 'name', name, 'room', room)
              order by grp, name) from lv_students), '[]'::jsonb));
  end if;
  return j;
end $$;

create or replace function lv_leaves_get(p_code text, p_op text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes;
begin
  r := lv_who(p_code);
  return jsonb_build_object('leaves', lv_all_json(lv_scope(r, p_op)),
                            'rev', lv_rev(), 'serverTime', now());
end $$;

create or replace function lv_students_get(p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['care', 'admin'], '看學員名單');
  return coalesce((select jsonb_agg(jsonb_build_object('sid', sid, 'grp', grp, 'name', name, 'room', room)
                          order by grp, name) from lv_students), '[]'::jsonb);
end $$;

/* 輪詢用。只回一個 rev 和幾個數字，前端每 8 秒打一次都不心疼。
   關懷員拿到的數字也只算他自己的單。 */
create or replace function lv_poll(p_code text, p_op text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; s text;
begin
  r := lv_who(p_code);
  s := lv_scope(r, p_op);
  return jsonb_build_object(
    'rev', lv_rev(),
    'wait',    (select count(*) from lv_leaves
                 where status = '等待簽核' and (s is null or care = s)),
    'out',     (select count(*) from lv_leaves
                 where status = '請假中'   and (s is null or care = s)),
    'overdue', (select count(*) from lv_leaves
                 where status = '請假中'   and due_at < now() and (s is null or care = s)),
    'serverTime', now());
end $$;


/* ══════════ 建立請假單（關懷員） ══════════ */

create or replace function lv_create(p_code text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  r lv_codes; l lv_leaves; open_no text; open_st text;
  v_name text; v_care text; v_out timestamptz; v_due timestamptz; v_sid text;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['care'], '填請假單');

  v_name := btrim(coalesce(p ->> 'name', ''));
  v_care := btrim(coalesce(p ->> 'care', ''));
  v_sid  := btrim(coalesce(p ->> 'sid', ''));
  if v_name = '' then raise exception '沒有選學員'; end if;
  if v_care = '' then raise exception '沒有填關懷員姓名'; end if;
  if btrim(coalesce(p ->> 'carePhone', '')) = '' then raise exception '沒有填關懷員電話'; end if;
  if btrim(coalesce(p ->> 'phone', ''))     = '' then raise exception '沒有填學員行動電話'; end if;

  v_out := lv_ts(p, 'out', '外出時間');
  v_due := lv_ts(p, 'due', '預計回來時間');
  if v_due <= v_out then raise exception '預計回來時間要晚於外出時間'; end if;

  /* 同一位學員身上不該同時有兩張沒結掉的單。紙本時代靠關懷員自己記得，
     上了系統就直接擋 —— 否則銷假時不知道要銷哪一張，兩張都留著又永遠不會消。
     兩邊都有錄取編號就比編號，同名同姓才不會被誤擋。 */
  select no, status into open_no, open_st from lv_leaves
   where status in ('等待簽核', '請假中')
     and (case when v_sid <> '' and sid <> '' then sid = v_sid else name = v_name end)
   limit 1;
  if open_no is not null then
    raise exception '% 已經有一張「%」的單（%），請先處理完那一張再開新的。',
                    v_name, open_st, open_no;
  end if;

  insert into lv_leaves (no, status, sid, grp, name, phone, room, reason,
                         out_at, due_at, care, care_phone, log)
  values ('L' || lpad(nextval('lv_no_seq')::text, 4, '0'), '等待簽核',
          v_sid,
          btrim(coalesce(p ->> 'grp', '')), v_name,
          btrim(coalesce(p ->> 'phone', '')), btrim(coalesce(p ->> 'room', '')),
          left(btrim(coalesce(p ->> 'reason', '')), 200),
          v_out, v_due, v_care, btrim(coalesce(p ->> 'carePhone', '')),
          lv_log('[]'::jsonb, v_care, r.label, '建立請假單'))
  returning * into l;

  return lv_json(l);
end $$;


/* ══════════ 修改 / 取消（關懷員） ══════════ */

/**
 * 「這張單是不是你開的」。
 *
 * 只擋關懷員 —— 行政中心在服務台代為銷假是刻意留的逃生門：
 * 學員回營時開單的關懷員可能正在忙、手機沒電、或已經換班，
 * 沒有這個出口的話那張單就永遠掛在「請假中」，沒有人能收尾。
 *
 * 名字是手打的，所以訊息要講清楚為什麼不給動，以及怎麼補救。
 */
create or replace function lv_mine(r lv_codes, l lv_leaves, p_op text, p_what text)
returns void language plpgsql immutable as $$
begin
  if r.role <> 'care' then return; end if;
  if l.care = btrim(coalesce(p_op, '')) then return; end if;
  raise exception '這張單是「%」開的，只有他本人能%。（如果這就是你，請登出後用一模一樣的名字重新登入；急件請找行政中心）',
                  l.care, p_what;
end $$;


/**
 * 只有「等待簽核」和「已退回」的單能改。
 * 簽核過的單不給改是刻意的：大組長同意的是他當時看到的時間和事由，
 * 事後被改掉那個簽核就沒有意義了。真的要改就取消重開一張。
 */
create or replace function lv_update(p_code text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves; v_out timestamptz; v_due timestamptz; v_op text;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['care'], '修改請假單');
  v_op := btrim(coalesce(p ->> 'op', ''));
  if v_op = '' then raise exception '沒有填你的名字'; end if;

  v_out := lv_ts(p, 'out', '外出時間');
  v_due := lv_ts(p, 'due', '預計回來時間');
  if v_due <= v_out then raise exception '預計回來時間要晚於外出時間'; end if;

  select * into cur from lv_leaves where no = p ->> 'no';
  if cur.no is null then raise exception '找不到單號 %', p ->> 'no'; end if;
  perform lv_mine(r, cur, v_op, '修改');
  if cur.status not in ('等待簽核', '已退回') then
    raise exception '這張單現在是「%」，不能修改。%', cur.status,
      case when cur.status = '請假中' then '已經簽核放行的單如果要改，請取消後重開一張。' else '' end;
  end if;

  update lv_leaves set
    status        = '等待簽核',
    phone         = btrim(coalesce(p ->> 'phone', '')),
    room          = btrim(coalesce(p ->> 'room', '')),
    reason        = left(btrim(coalesce(p ->> 'reason', '')), 200),
    out_at        = v_out,
    due_at        = v_due,
    care_phone    = coalesce(nullif(btrim(coalesce(p ->> 'carePhone', '')), ''), care_phone),
    -- 重新送審就是新的一輪，舊的退回原因清掉，但紀錄欄裡留著
    reject_reason = null,
    overdue_notified = false,
    updated_at    = now(),
    log = lv_log(log, v_op, r.label,
                 case when cur.status = '已退回' then '修改後重新送審' else '修改請假單' end)
  where no = cur.no
  returning * into l;

  return lv_json(l);
end $$;

create or replace function lv_cancel(p_code text, p_no text, p_op text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['care'], '取消請假單');
  if btrim(coalesce(p_op, '')) = '' then raise exception '沒有填你的名字'; end if;

  /* 先讀出來檢查，再更新。原本是「更新不到再回頭查原因」，
     但加了「是不是你開的」之後，那種寫法會把「別人的單」和
     「狀態不對」混成同一個錯誤，現場看不出到底是哪一種。 */
  select * into cur from lv_leaves where no = p_no;
  if cur.no is null then raise exception '找不到單號 %', p_no; end if;
  perform lv_mine(r, cur, p_op, '取消');
  if cur.status not in ('等待簽核', '已退回') then
    raise exception '這張單現在是「%」，不能取消。%', cur.status,
      case when cur.status = '請假中' then '學員已經放行了，請等他回營再銷假。' else '' end;
  end if;

  update lv_leaves set status = '已取消', updated_at = now(),
         log = lv_log(log, p_op, r.label, '取消請假單')
   where no = p_no and status in ('等待簽核', '已退回')
  returning * into l;

  if l.no is null then raise exception '這張單剛剛被別人處理過了，請重新整理'; end if;
  return lv_json(l);
end $$;


/* ══════════ 簽核 / 退回（大組長、副大組長） ══════════ */

create or replace function lv_approve(p_code text, p_no text, p_op text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['lead', 'deputy'], '簽核請假單');
  if btrim(coalesce(p_op, '')) = '' then raise exception '請先填你的名字，簽核要記錄是誰簽的'; end if;

  update lv_leaves set
    status = '請假中', approver = p_op, approver_role = r.label,
    approved_at = now(), reject_reason = null, updated_at = now(),
    log = lv_log(log, p_op, r.label, '簽核同意，學員可離營')
   where no = p_no and status = '等待簽核'
  returning * into l;

  /* 兩位大組長同時按下去，第二位會落到這裡。
     告訴他是誰先簽的，而不是丟一句「操作失敗」讓他懷疑自己按錯。 */
  if l.no is null then
    select * into cur from lv_leaves where no = p_no;
    if cur.no is null then raise exception '找不到單號 %', p_no; end if;
    raise exception '這張單已經是「%」了%，不需要再簽。', cur.status,
      case when cur.approver is not null
           then '（' || cur.approver || ' 於 ' ||
                to_char(cur.approved_at at time zone 'Asia/Taipei', 'HH24:MI') || ' 處理）'
           else '' end;
  end if;
  return lv_json(l);
end $$;

create or replace function lv_reject(p_code text, p_no text, p_op text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['lead', 'deputy'], '退回請假單');
  if btrim(coalesce(p_op, ''))     = '' then raise exception '請先填你的名字'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception '退回一定要填原因，關懷員才知道要改什麼'; end if;

  update lv_leaves set
    status = '已退回', approver = p_op, approver_role = r.label,
    approved_at = now(), reject_reason = left(btrim(p_reason), 200), updated_at = now(),
    log = lv_log(log, p_op, r.label, '退回：' || btrim(p_reason))
   where no = p_no and status = '等待簽核'
  returning * into l;

  if l.no is null then
    select * into cur from lv_leaves where no = p_no;
    if cur.no is null then raise exception '找不到單號 %', p_no; end if;
    raise exception '這張單已經是「%」了，不能退回。請重新整理。', cur.status;
  end if;
  return lv_json(l);
end $$;


/* ══════════ 銷假（關懷員；行政中心當服務台備援） ══════════ */

create or replace function lv_close(p_code text, p_no text, p_op text, p_back text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves; v_back timestamptz; v_late int;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['care', 'admin'], '銷假');
  if btrim(coalesce(p_op, '')) = '' then raise exception '沒有填你的名字'; end if;
  v_back := lv_ts(jsonb_build_object('back', p_back), 'back', '實際回來時間');

  select * into cur from lv_leaves where no = p_no;
  if cur.no is null then raise exception '找不到單號 %', p_no; end if;
  perform lv_mine(r, cur, p_op, '銷假');
  if cur.status = '完成銷假' then
    raise exception '這張單已經銷假了（實際回來 %），不用再銷一次。',
      to_char(cur.back_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI');
  end if;
  if cur.status <> '請假中' then
    raise exception '這張單現在是「%」，還沒放行，不能銷假。', cur.status;
  end if;
  if v_back < cur.out_at then raise exception '實際回來時間比外出時間還早，請確認一下'; end if;

  v_late := greatest(0, floor(extract(epoch from (v_back - cur.due_at)) / 60)::int);
  update lv_leaves set status = '完成銷假', back_at = v_back, updated_at = now(),
         log = lv_log(log, p_op, r.label,
                      '銷假，實際回來 ' || to_char(v_back at time zone 'Asia/Taipei', 'MM/DD HH24:MI')
                      || case when v_late > 1 then '（逾時 ' || v_late || ' 分）' else '' end)
   where no = p_no and status = '請假中'
  returning * into l;

  if l.no is null then raise exception '這張單剛剛被別人處理過了，請重新整理'; end if;
  return lv_json(l);
end $$;


/* ══════════ 作廢（行政中心） ══════════ */
/**
 * 誤開的單、營期前的測試單，需要一個乾淨的出口。
 *
 * 為什麼是「作廢」而不是真的刪除：學員外出期間萬一出事，那張單是唯一的
 * 書面證據。真的把那一列拿掉之後，誰在幾點、為什麼刪的，沒有任何人查得回來。
 * 所以這裡跟報到系統的關懷員備註同一個原則 —— 劃掉，不是拿掉。
 *
 * 任何狀態都可以作廢，包含已經簽核放行的「請假中」——
 * 那正是最需要它的情況：關懷員自己不能取消已放行的單，
 * 沒有這一支的話唯一的出路是按「銷假」，
 * 而那會留下一筆學員根本沒出去過的「完成銷假」紀錄。
 */
create or replace function lv_void(p_code text, p_no text, p_op text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes; l lv_leaves; cur lv_leaves;
begin
  r := lv_who(p_code);
  perform lv_need(r, array['admin'], '作廢請假單');
  if btrim(coalesce(p_op, ''))     = '' then raise exception '沒有填你的名字'; end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception '作廢一定要填原因。這張單會留在紀錄裡，之後看到的人要知道為什麼';
  end if;

  select * into cur from lv_leaves where no = p_no;
  if cur.no is null then raise exception '找不到單號 %', p_no; end if;
  if cur.status = '已取消' then
    raise exception '這張單已經是「已取消」了'; end if;

  update lv_leaves set
    status = '已取消', void_reason = left(btrim(p_reason), 200),
    overdue_notified = true,          -- 作廢掉的單不該再跳逾時提醒
    updated_at = now(),
    log = lv_log(log, p_op, r.label, '作廢（原狀態：' || cur.status || '）：' || btrim(p_reason))
   where no = p_no and status <> '已取消'
  returning * into l;

  if l.no is null then raise exception '這張單剛剛被別人處理過了，請重新整理'; end if;
  return lv_json(l);
end $$;


/* ══════════ 推播裝置 ══════════ */

create or replace function lv_device_add(p_code text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes;
begin
  r := lv_who(p_code);
  if coalesce(p ->> 'endpoint', '') = '' then raise exception '沒有收到裝置資料'; end if;

  -- 同一支手機重新開啟推播會拿到同一個 endpoint，更新那一列就好，不要一直長新的
  insert into lv_devices (endpoint, p256dh, auth, role, person, dead, last_error)
  values (p ->> 'endpoint', p ->> 'p256dh', p ->> 'auth', r.role,
          btrim(coalesce(p ->> 'op', '')), false, null)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh, auth = excluded.auth, role = excluded.role,
    person = excluded.person, dead = false, last_error = null;

  return jsonb_build_object('ok', true);
end $$;

create or replace function lv_device_del(p_code text, p_endpoint text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r lv_codes;
begin
  r := lv_who(p_code);
  delete from lv_devices where endpoint = p_endpoint;
  return jsonb_build_object('ok', true);
end $$;

/* 推播的 Edge Function 用 service_role 呼叫這一支拿要送的名單。
   anon 拿不到 —— 裡面有加密金鑰。 */
create or replace function lv_targets(p_roles text[])
returns setof lv_devices language sql security definer set search_path = public as $$
  select * from lv_devices where dead = false and role = any(p_roles)
$$;
revoke all on function lv_targets(text[]) from public, anon, authenticated;


/* ══════════ 逾時未回營 ══════════ */
/**
 * 「請假中」而且超過預計回來時間 30 分鐘以上、還沒提醒過的單。
 * 推播的 Edge Function 會來問這一支（見 supabase/functions/push）。
 * 每張單只提醒一次，不會每十分鐘吵一遍。
 */
create or replace function lv_overdue_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
declare j jsonb;
begin
  /* update … returning 放在 CTE 裡，是為了「標記」和「取出」在同一個交易裡完成。
     先查再更新的話，排程剛好重複觸發時同一張單會提醒兩次。 */
  with pick as (
    update lv_leaves set overdue_notified = true, updated_at = now(),
           log = lv_log(log, '系統', '系統', '已提醒逾時未回營')
     where status = '請假中' and overdue_notified = false
       and due_at < now() - interval '30 minutes'
    returning no, grp, name, care, care_phone, due_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'event', 'overdue',
    'title', '學員逾時未回營',
    'body',  grp || ' ' || name || ' 已逾時 ' ||
             floor(extract(epoch from (now() - due_at)) / 60)::int ||
             ' 分未回營。關懷員 ' || care || ' ' || care_phone,
    'roles', jsonb_build_array('admin', 'care'),
    'url',   coalesce((select value from lv_settings where key = 'app_url'), ''),
    -- 逾時提醒同樣只給行政中心和「開這張單的那位」關懷員
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
        'endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth))
      from lv_devices d
      where d.dead = false
        and (d.role = 'admin' or (d.role = 'care' and d.person = pick.care))), '[]'::jsonb)
  )), '[]'::jsonb) into j from pick;
  return j;
end $$;
revoke all on function lv_overdue_jobs() from public, anon, authenticated;


/* 雜項設定。目前只放 app_url（推播點下去要開哪個網址）。
   寫在資料庫而不是 Edge Function 的環境變數裡，網址換了不用重新部署。
     select lv_set('app_url', 'https://bmbill.github.io/checkin_youngone_2026/leave/'); */
create table if not exists lv_settings (
  key text primary key,
  value text not null default ''
);
alter table lv_settings enable row level security;
revoke all on lv_settings from anon, authenticated;

create or replace function lv_set(p_key text, p_value text)
returns text language sql security definer set search_path = public as $$
  insert into lv_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value
  returning key || ' = ' || value;
$$;


/* ══════════ 推播內容 ══════════
   通知的文字在這裡產生，不在前端也不在 Edge Function ——
   前端是公開的，讓它自己決定「要通知誰、寫什麼」，等於誰都能拿 anon key
   對全體幹部的手機發任意內容。

   同時檢查「這個事件跟這張單現在的狀態合不合」：
   例如只有還在等待簽核的單才能發「有新單待簽核」，
   拿到通行碼的人也沒辦法對同一張單重複轟炸。 */

create or replace function lv_push_prepare(p_code text, p_event text, p_no text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  r lv_codes; l lv_leaves;
  v_roles text[]; v_title text; v_body text;
  f_out text; f_due text;
begin
  r := lv_who(p_code);
  select * into l from lv_leaves where no = p_no;
  if l.no is null then raise exception '找不到單號 %', p_no; end if;

  f_out := to_char(l.out_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI');
  f_due := to_char(l.due_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI');

  if p_event = 'new' then
    perform lv_need(r, array['care'], '發出待簽核通知');
    if l.status <> '等待簽核' then return jsonb_build_object('skip', true); end if;
    v_roles := array['lead', 'deputy', 'admin'];
    v_title := '有新的請假單待簽核';
    v_body  := l.grp || ' ' || l.name || '　' || f_out || ' → ' || f_due ||
               case when l.reason <> '' then '（' || l.reason || '）' else '' end;

  elsif p_event = 'approved' then
    perform lv_need(r, array['lead', 'deputy'], '發出簽核通知');
    if l.status <> '請假中' then return jsonb_build_object('skip', true); end if;
    v_roles := array['care', 'admin'];
    v_title := '請假已簽核通過';
    v_body  := l.grp || ' ' || l.name || '　' || coalesce(l.approver, '') ||
               '(' || coalesce(l.approver_role, '') || ') 已同意，預計 ' || f_due || ' 回營';

  elsif p_event = 'rejected' then
    perform lv_need(r, array['lead', 'deputy'], '發出退回通知');
    if l.status <> '已退回' then return jsonb_build_object('skip', true); end if;
    v_roles := array['care', 'admin'];
    v_title := '請假單被退回';
    v_body  := l.grp || ' ' || l.name || '　' || coalesce(l.approver, '') || '：' ||
               coalesce(l.reject_reason, '');

  elsif p_event = 'voided' then
    perform lv_need(r, array['admin'], '發出作廢通知');
    if l.status <> '已取消' then return jsonb_build_object('skip', true); end if;
    v_roles := array['care'];
    v_title := '請假單已被作廢';
    v_body  := l.grp || ' ' || l.name || '　' || coalesce(l.void_reason, '');

  elsif p_event = 'closed' then
    perform lv_need(r, array['care', 'admin'], '發出銷假通知');
    if l.status <> '完成銷假' then return jsonb_build_object('skip', true); end if;
    v_roles := array['admin'];
    v_title := '已完成銷假';
    v_body  := l.grp || ' ' || l.name || '　實際回來 ' ||
               to_char(l.back_at at time zone 'Asia/Taipei', 'MM/DD HH24:MI');
  else
    raise exception '不認識的通知類型：%', p_event;
  end if;

  /* 簽核通過／被退回，只該吵開這張單的那一位關懷員。
     不分的話，全場每位關懷員的手機都會為別人的每一張單響一次 ——
     營期第一個晚上就會有人把通知關掉，然後就再也收不到自己的了。
     lv_devices.person 就是那支手機登入時打的名字，跟單子上的 care 對得起來。 */
  return jsonb_build_object(
    'event', p_event, 'title', v_title, 'body', v_body, 'roles', v_roles,
    'url', coalesce((select value from lv_settings where key = 'app_url'), ''),
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
        'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
      from lv_devices
      where dead = false and role = any(v_roles)
        and (role <> 'care' or person = l.care)), '[]'::jsonb));
end $$;

/* 推播結果回報。哪支手機的代碼死了就標記起來，
   下次不用再花時間送給它，也留下痕跡回答「為什麼我沒收到」。 */
create or replace function lv_push_finish(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  insert into lv_pushlog (event, title, body, roles, sent, failed, detail)
  values (p ->> 'event', p ->> 'title', p ->> 'body',
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'roles') t(x)), '{}'),
          coalesce((p ->> 'sent')::int, 0), coalesce((p ->> 'failed')::int, 0), p ->> 'detail');

  update lv_devices set last_ok = now(), last_error = null
   where endpoint in (select jsonb_array_elements_text(coalesce(p -> 'okEndpoints', '[]'::jsonb)));

  update lv_devices set dead = true, last_error = p ->> 'detail'
   where endpoint in (select jsonb_array_elements_text(coalesce(p -> 'deadEndpoints', '[]'::jsonb)));

  return jsonb_build_object('ok', true);
end $$;

/* ══════════ 權限收尾 ══════════
   這一段一定要在所有函式都建好之後跑，而且順序是「先全收回、再逐一開放」。
   為什麼不能只 revoke from anon：PostgreSQL 建立函式時會**預設把 EXECUTE
   授權給 PUBLIC**，而 anon 是 PUBLIC 的一員。只收回 anon 的權限，PUBLIC 那份
   還在，等於下面這些都還是開著的 ——
     lv_set_code  → 任何人都能改掉四組通行碼
     lv_all_json  → 任何人都能倒出全部學員的姓名和電話
   anon key 就寫在公開的 leave/index.html 裡，所以這不是理論上的風險。 */

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'lv\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

/* 開放清單：手機上那一頁只能呼叫這些，每一支的第一行都是 lv_who() 驗通行碼。 */
do $$
declare f text;
begin
  foreach f in array array[
    'lv_bootstrap(text,text)', 'lv_leaves_get(text,text)', 'lv_students_get(text)',
    'lv_poll(text,text)',
    'lv_create(text,jsonb)', 'lv_update(text,jsonb)', 'lv_cancel(text,text,text)',
    'lv_approve(text,text,text)', 'lv_reject(text,text,text,text)',
    'lv_close(text,text,text,text)', 'lv_void(text,text,text,text)',
    'lv_device_add(text,jsonb)', 'lv_device_del(text,text)'
  ] loop
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

/* Edge Function 用 service_role 呼叫這些內部函式。
   上面那一輪全域 revoke 只收回 public/anon/authenticated，
   但 service_role 原本的權限也是從 PUBLIC 那份來的，所以這裡要明確補回來。 */
grant execute on function lv_who(text)                       to service_role;
grant execute on function lv_all_json(text)                  to service_role;
grant execute on function lv_rev()                           to service_role;
grant execute on function lv_push_prepare(text, text, text)  to service_role;
grant execute on function lv_push_finish(jsonb)               to service_role;
grant execute on function lv_overdue_jobs()                  to service_role;
grant execute on function lv_set(text, text)                 to service_role;

/* 檢查用：跑完之後這一句應該只列出上面那 12 支。
   多出任何一支（尤其是 lv_set_code、lv_who、lv_all_json、lv_targets、
   lv_overdue_jobs）就是有問題，不要上線。
     select p.proname, p.oid::regprocedure
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'lv\_%'
        and has_function_privilege('anon', p.oid, 'EXECUTE'); */


/* ══════════ 選用：即時通知 ══════════
   有了這一段，關懷員按下送出的那一秒，大組長手機上的清單就會跳出來，
   不用等輪詢的 8 秒。沒有這一段系統照常運作，只是慢幾秒。

   廣播的內容刻意只有「rev 變了、目前幾張待簽核」這種不敏感的數字 ——
   廣播頻道是拿 anon key 就能訂的，學員姓名不能走這條路。
   前端收到廣播只是知道「該去問一次」，真正的資料還是走上面那些要驗通行碼的函式。 */

create or replace function lv_broadcast() returns trigger
language plpgsql security definer set search_path = public, realtime as $$
begin
  perform realtime.send(
    jsonb_build_object('rev', lv_rev(),
                       'wait', (select count(*) from lv_leaves where status = '等待簽核')),
    'changed', 'lv', false);
  return null;
exception when others then
  -- 廣播失敗不能讓請假單寫不進去。前端還有輪詢兜著。
  return null;
end $$;

drop trigger if exists lv_leaves_broadcast on lv_leaves;
create trigger lv_leaves_broadcast
after insert or update on lv_leaves
for each statement execute function lv_broadcast();
