/**
 * 報到管理系統 - 外部掃碼 API 層  (v2)
 *
 * 用途：讓「外部靜態主機（GitHub Pages）上的掃碼頁」能讀寫這份試算表。
 *
 * v2 相對 v1 的四個修正：
 *   1. 欄位改用「標題名稱」定位，不再用「最後三欄」。備註有兩個（H、M），取後面的 M 欄。
 *   2. 因此在 Q 欄以後打字、或在中間插欄，都不會再無聲錯位；標題被改掉會直接回報錯誤。
 *   3. 幹部名字獨立寫進「掃碼人」欄；備註欄只放幹部真的打的字，掃碼時完全不動備註欄。
 *   4. 時間戳記改用不受專案時區影響的解析方式，delta 同步不會再漏抓。
 *
 * 安裝：Apps Script 專案 → Api.gs → 全選貼上本檔全文 → 存檔 → 重新部署
 */

const API_CONFIG = {
  // ★★ 改成只有你們幹部知道的字串，要和 index.html 裡輸入的通行碼一模一樣 ★★
  TOKEN: ''
};

/* ══════════ 欄位定位：認標題，不認位置 ══════════ */
/**
 * 名單上這四個標題就是系統要寫的欄位。
 * 「備註」在 H 欄和 M 欄各有一個，用 lastIndexOf 取後面那個 = M 欄。
 * 所以往右加欄位（Q、R、S…）或在中間插欄，都不會再把資料寫錯地方。
 * 代價是：這四個標題文字不能改，改了系統會直接報錯而不是默默寫錯。
 */
const COL_NAMES = { check: '報到', note: '備註', op: '掃碼人', time: '時間戳記' };

function sysIdx_(headers) {
  var idx = {}, missing = [];
  Object.keys(COL_NAMES).forEach(function (k) {
    var i = headers.lastIndexOf(COL_NAMES[k]);
    if (i < 0) missing.push(COL_NAMES[k]);
    idx[k] = i;
  });
  if (missing.length) {
    throw new Error('名單第一列找不到欄位標題：' + missing.join('、') +
                    '。請把標題文字改回來（不要改字、不要留空格）。');
  }
  return idx;
}

/**
 * 時間戳記是用 GMT+8 格式化寫進去的字串（2026/08/15 19:18:00）。
 * 原本的 new Date(字串) 會用「Apps Script 專案時區」去解讀它，
 * 專案時區只要不是台北，就會整批差好幾個小時，delta 同步會漏抓或重抓。
 * 這裡直接把字串當成 UTC+8 換算成 epoch 毫秒，跟專案時區完全脫鉤。
 */
function parseTs_(s) {
  var m = String(s).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}


/* ══════════ 路由 ══════════ */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // 帶 api=1 → 走 JSONP API（給外部掃碼頁）
  if (p.api) return handleApi_(p);

  // 否則維持原本的 Apps Script 網頁版（保留當備援）
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('(測試用)報到管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}


function handleApi_(p) {
  var cb = p.callback || '';
  try {
    if (p.token !== API_CONFIG.TOKEN) {
      return jsonOut_({ error: 'BAD_TOKEN', message: '通行碼錯誤' }, cb);
    }

    switch (p.action) {
      case 'getAllData':
        return jsonOut_(getAllData(), cb);

      case 'getDeltaUpdates':
        return jsonOut_(getDeltaUpdates(Number(p.lastSyncTime) || 0,
                                        Number(p.localTotalRows) || 0), cb);

      case 'updateData':
        return jsonOut_(apiUpdate_(p), cb);

      default:
        return jsonOut_({ error: 'BAD_ACTION', message: '不支援的動作：' + p.action }, cb);
    }
  } catch (err) {
    return jsonOut_({ error: 'SERVER_ERROR', message: String((err && err.message) || err) }, cb);
  }
}


function jsonOut_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}


/* ══════════ 寫入（多人同時掃碼安全版） ══════════ */
/**
 * guard=1（掃碼自動報到）：若該員已報到，不覆寫原始時間，只回報重複。
 * guard=0（人工按「確認寫入雲端」）：照常寫入，讓幹部能補改備註。
 *
 * note 參數沒帶（掃碼時就是沒帶）→ 備註欄完全不動，
 * 才不會把名單上原本填好的備註洗成空白。
 */
function apiUpdate_(p) {
  var row     = Number(p.row);
  var isCheck = (p.check === 'true' || p.check === '1' || p.check === true);
  var hasNote = (p.note !== undefined && p.note !== null);
  var note    = String(p.note || '');
  var op      = String(p.op || '');
  var guard   = (p.guard === '1' || p.guard === 1);

  if (!row || row < 2) return { error: 'BAD_ROW', message: '列號不正確' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { error: 'BUSY', message: '系統忙碌中，請再試一次' };

  try {
    var sheet   = SpreadsheetApp.getActive().getSheetByName(CONFIG.SOURCE_SHEET);
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var idx     = sysIdx_(headers);

    var lo = Math.min(idx.check, idx.note, idx.op, idx.time);
    var hi = Math.max(idx.check, idx.note, idx.op, idx.time);

    var rng  = sheet.getRange(row, lo + 1, 1, hi - lo + 1);
    var cur  = rng.getDisplayValues()[0];
    var name = sheet.getRange(row, 2).getDisplayValue();

    // 已報到過就不蓋掉原始時間，讓第二個掃到的幹部知道有人先刷了
    if (guard && isCheck && String(cur[idx.check - lo]) === '1') {
      return {
        success: true, duplicate: true, row: row, check: true,
        note: cur[idx.note - lo], op: cur[idx.op - lo], time: cur[idx.time - lo],
        name: name
      };
    }

    var now = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');

    if (hi - lo + 1 === 4) {
      // 四欄相連（目前是 M~P），一次寫入最快
      var out = cur.slice();
      out[idx.check - lo] = isCheck ? '1' : '0';
      out[idx.op    - lo] = op;
      out[idx.time  - lo] = now;
      if (hasNote) out[idx.note - lo] = note;
      rng.setValues([out]);
    } else {
      // 中間夾了別的欄位 → 逐格寫，免得把人家的公式蓋成純文字
      sheet.getRange(row, idx.check + 1).setValue(isCheck ? '1' : '0');
      sheet.getRange(row, idx.op    + 1).setValue(op);
      sheet.getRange(row, idx.time  + 1).setValue(now);
      if (hasNote) sheet.getRange(row, idx.note + 1).setValue(note);
    }

    return {
      success: true, duplicate: false, row: row, check: isCheck,
      note: hasNote ? note : cur[idx.note - lo], op: op, time: now, name: name
    };

  } finally {
    lock.releaseLock();
  }
}


/* ══════════ 讀取 ══════════ */

function getAllData() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.SOURCE_SHEET);
  var data = sheet.getDataRange().getDisplayValues();
  var headers = data[0];
  return {
    headers: headers,
    rows: data.slice(1),
    serverTime: new Date().getTime(),
    totalRows: data.length,
    sysIndices: sysIdx_(headers)
  };
}

function getDeltaUpdates(lastSyncTime, localTotalRows) {
  var data = SpreadsheetApp.getActive().getSheetByName(CONFIG.SOURCE_SHEET).getDataRange().getDisplayValues();
  var timeIdx = sysIdx_(data[0]).time;
  var updates = [], newRows = [];
  for (var i = 1; i < data.length; i++) {
    if (i + 1 > localTotalRows) newRows.push({ row: i + 1, values: data[i] });
    else if (data[i][timeIdx] && parseTs_(data[i][timeIdx]) > lastSyncTime) {
      updates.push({ row: i + 1, values: data[i] });
    }
  }
  return { updates: updates, newRows: newRows, serverTime: new Date().getTime(), serverTotalRows: data.length };
}
