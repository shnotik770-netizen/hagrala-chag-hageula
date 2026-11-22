/**
 * הגרלת חג הגאולה י"ט-כ' כסלו תשפ"ז — מרכז חב"ד עפולה
 * צד שרת: Google Apps Script שמחובר לגיליון Google Sheets.
 *
 * מה הקוד עושה:
 *  - שומר כל כרטיס הגרלה בשורה נפרדת בלשונית "כרטיסים".
 *  - פותח עסקה בנדרים פלוס בצד השרת (הסכום ננעל כאן, לא בדפדפן) ומקבל את
 *    אישור התשלום ב-CallBack (Webhook) שנדרים פלוס שולחים ישירות לכאן.
 *  - מנהל קודי קופון של מורשים (רישום ללא חיוב) בלשונית "מורשים".
 *  - שולח SMS דרך ימות המשיח ומייל עם הכרטיסים.
 *  - ממשק ניהול מוגן בסיסמה.
 *
 * הגדרות (Project Settings > Script properties) — אף סוד לא נשמר בקוד:
 *  NEDARIM_MOSAD      (אופציונלי) דורס את מספר המוסד שבקוד
 *  NEDARIM_API_VALID  (אופציונלי) דורס את ApiValid שבקוד
 *  ADMIN_PASSWORD     סיסמת כניסה לממשק הניהול
 *  YEMOT_TOKEN        (אופציונלי) טוקן API של ימות המשיח לשליחת SMS
 *  YEMOT_SMS_FROM     (אופציונלי) שם שולח מאושר, למשל: חבד עפולה
 *  WEB_APP_URL        כתובת ה-Web App (מסתיימת ב-/exec) — משמשת ככתובת CallBack
 */

var CONFIG = {
  TICKET_PRICE: 25,
  MAX_TICKETS_PER_ORDER: 30,
  FIRST_TICKET_NUMBER: 67706201,
  NEDARIM_MOSAD: '7005953',
  NEDARIM_API_VALID: 'iOofx+nKL/', // לא סודי (לפי מרכז חב"ד); אפשר לדרוס ב-Script property
  NEDARIM_GROUPE: 'הגרלה יט כסלו תשפז',
  NEDARIM_CREATE_URL: 'https://matara.pro/nedarimplus/V6/Files/WebServices/DebitIframe.aspx?Action=CreateTransaction',
  YEMOT_SMS_URL: 'https://www.call2all.co.il/ym/api/SendSms',
  EVENT_TITLE: 'הגרלת הענק • התוועדות חג הגאולה י"ט-כ\' כסלו',
  EVENT_LINE: 'יום שני כ\' כסלו (30.11) • 19:30 • אולמי פאר בראשית',
  ORG_NAME: 'מרכז חב"ד עפולה'
};

var SHEETS = {
  TICKETS: 'כרטיסים',
  ORDERS: 'הזמנות',
  COUPONS: 'מורשים',
  LOG: 'לוג'
};

var HEADERS = {};
HEADERS[SHEETS.TICKETS] = ['מס\' כרטיס', 'תאריך', 'שם על הכרטיס', 'שם המשלם', 'טלפון', 'אימייל', 'ת"ז', 'אופן רישום', 'אסמכתא', 'סכום', 'מס\' הזמנה'];
HEADERS[SHEETS.ORDERS] = ['מס\' הזמנה', 'מזהה לקוח', 'נוצר', 'סטטוס', 'כמות', 'סכום', 'שם המשלם', 'טלפון', 'אימייל', 'ת"ז', 'שמות (JSON)', 'קופון', 'מזהה עסקה בנדרים', 'שולם בתאריך', 'כרטיסים', 'הערה'];
HEADERS[SHEETS.COUPONS] = ['שם המורשה', 'קוד קופון', 'מגבלת כרטיסים', 'פעיל', 'נוצר'];
HEADERS[SHEETS.LOG] = ['זמן', 'סוג', 'פרטים'];

// עמודות בלשונית הזמנות (מבוסס 1)
var O = { ID: 1, CLIENT: 2, CREATED: 3, STATUS: 4, QTY: 5, AMOUNT: 6, NAME: 7, PHONE: 8, EMAIL: 9, ZEOUT: 10, NAMES: 11, COUPON: 12, TXID: 13, PAID_AT: 14, TICKETS: 15, NOTE: 16 };

/* ======================= HTTP ======================= */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'config') return json_(publicConfig_());
  return json_({ ok: true });
}

function doPost(e) {
  var body = parseBody_(e);

  // CallBack מנדרים פלוס: אין שדה action, יש Param2
  if (!body.action && (body.Param2 || body.TransactionId)) {
    return json_(handleNedarimCallback_(body));
  }

  try {
    switch (body.action) {
      case 'config': return json_(publicConfig_());
      case 'checkCoupon': return json_(checkCoupon_(body));
      case 'createOrder': return json_(createOrder_(body));
      case 'orderStatus': return json_(orderStatus_(body));
      case 'clientConfirm': return json_(clientConfirm_(body));
      case 'adminLogin': return json_(adminLogin_(body));
      case 'adminData': requireAdmin_(body); return json_(adminData_());
      case 'adminAddCoupon': requireAdmin_(body); return json_(adminAddCoupon_(body));
      case 'adminToggleCoupon': requireAdmin_(body); return json_(adminToggleCoupon_(body));
      case 'adminApproveOrder': requireAdmin_(body); return json_(adminApproveOrder_(body));
      case 'adminResendSms': requireAdmin_(body); return json_(adminResendSms_(body));
      case 'adminSetOpen': requireAdmin_(body); return json_(adminSetOpen_(body));
      default: return json_({ ok: false, error: 'פעולה לא מוכרת.' });
    }
  } catch (err) {
    log_('error', (body.action || '') + ': ' + (err && err.message));
    return json_({ ok: false, error: (err && err.userMessage) || 'אירעה שגיאה. נסו שוב בעוד רגע.' });
  }
}

function parseBody_(e) {
  var out = {};
  if (e && e.parameter) Object.keys(e.parameter).forEach(function (k) { out[k] = e.parameter[k]; });
  if (e && e.postData && e.postData.contents) {
    try {
      var parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === 'object') Object.keys(parsed).forEach(function (k) { out[k] = parsed[k]; });
    } catch (ignore) { /* form-encoded — כבר ב-e.parameter */ }
  }
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(msg) {
  var err = new Error(msg);
  err.userMessage = msg;
  return err;
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

/* ======================= גיליונות ======================= */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS[name]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold').setBackground('#7c0a18').setFontColor('#fbe3a3');
    sh.setRightToLeft(true);
  }
  return sh;
}

/** מריצים פעם אחת מהעורך: יוצר את כל הלשוניות + קופון לדוגמה. */
function setup() {
  Object.keys(SHEETS).forEach(function (k) { sheet_(SHEETS[k]); });
  var coupons = sheet_(SHEETS.COUPONS);
  if (coupons.getLastRow() < 2) {
    coupons.appendRow(['משרד מרכז חב"ד עפולה', 'CHABAD770', '', true, new Date()]);
  }
  var def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('גיליון1');
  if (def && def.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(def);
}

function rows_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS[name].length).getValues();
}

function log_(type, details) {
  try {
    sheet_(SHEETS.LOG).appendRow([new Date(), type, String(details).slice(0, 45000)]);
  } catch (ignore) {}
}

/* ======================= עזרים ======================= */

function normalizePhone_(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (d.indexOf('00972') === 0) d = '0' + d.slice(5);
  else if (d.indexOf('972') === 0) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? d : null;
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
}

// מונע הזרקת נוסחאות לגיליון (שם שמתחיל ב-=,+,-,@)
function safeCell_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function uuid_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function fmtDate_(d) {
  return Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm');
}

function publicConfig_() {
  return { ok: true, price: CONFIG.TICKET_PRICE, maxTickets: CONFIG.MAX_TICKETS_PER_ORDER, open: isOpen_() };
}

/** האם ההרשמה פתוחה (נשלט מממשק הניהול). */
function isOpen_() {
  return prop_('REGISTRATION_OPEN') !== 'no';
}

function requireOpen_() {
  if (!isOpen_()) throw userError_('ההרשמה להגרלה נסגרה.');
}

/* ======================= קופונים ======================= */

function findCoupon_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var data = rows_(SHEETS.COUPONS);
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]).trim().toUpperCase() === code) {
      var limit = data[i][2] === '' || data[i][2] === null ? null : Number(data[i][2]);
      var active = data[i][3] === true || String(data[i][3]).toUpperCase() === 'TRUE' || data[i][3] === 'כן';
      return { row: i + 2, owner: String(data[i][0]), code: code, limit: isNaN(limit) ? null : limit, active: active };
    }
  }
  return null;
}

function couponUsage_(code) {
  var count = 0;
  rows_(SHEETS.TICKETS).forEach(function (r) {
    if (r[7] === 'קוד קופון' && String(r[8]).toUpperCase() === code) count++;
  });
  return count;
}

function validateCoupon_(code, qty) {
  var c = findCoupon_(code);
  if (!c) throw userError_('קוד הקופון לא נמצא.');
  if (!c.active) throw userError_('קוד הקופון הושהה.');
  if (c.limit !== null) {
    var used = couponUsage_(c.code);
    if (used + qty > c.limit) throw userError_('חריגה ממכסת הכרטיסים של קוד זה (נותרו ' + Math.max(0, c.limit - used) + ').');
  }
  return c;
}

function checkCoupon_(body) {
  requireOpen_();
  var qty = Math.max(1, Math.min(CONFIG.MAX_TICKETS_PER_ORDER, parseInt(body.qty, 10) || 1));
  var c = validateCoupon_(body.code, qty);
  return { ok: true, owner: c.owner, code: c.code };
}

/* ======================= הזמנות ======================= */

function readOrderInput_(body) {
  var name = clean_(body.payerName, 60);
  var phone = normalizePhone_(body.payerPhone);
  var email = clean_(body.payerEmail, 80);
  var zeout = String(body.payerId || '').replace(/\D/g, '').slice(0, 9);
  var names = Array.isArray(body.ticketNames) ? body.ticketNames : [];
  names = names.map(function (n) { return clean_(n, 60); });

  if (!name) throw userError_('חובה להזין את שם המשלם.');
  if (!phone) throw userError_('מספר הטלפון אינו תקין.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw userError_('כתובת המייל אינה תקינה.');
  if (zeout && zeout.length < 5) throw userError_('מספר תעודת הזהות אינו תקין.');
  if (!names.length || names.length > CONFIG.MAX_TICKETS_PER_ORDER) throw userError_('מספר הכרטיסים אינו תקין.');
  for (var i = 0; i < names.length; i++) {
    if (!names[i]) throw userError_('חובה להזין שם עבור כרטיס #' + (i + 1) + '.');
  }
  return { name: name, phone: phone, email: email, zeout: zeout, names: names };
}

function createOrder_(body) {
  requireOpen_();
  var input = readOrderInput_(body);
  var qty = input.names.length;
  var orderId = uuid_();     // סודי — נשלח לנדרים כ-Param2 ולא נחשף לדפדפן
  var clientToken = uuid_(); // לדפדפן — לבדיקת סטטוס בלבד
  var couponCode = String(body.coupon || '').trim().toUpperCase();

  if (couponCode) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var c = validateCoupon_(couponCode, qty);
      sheet_(SHEETS.ORDERS).appendRow([orderId, clientToken, new Date(), 'paid', qty, 0, safeCell_(input.name), "'" + input.phone,
        input.email, input.zeout ? "'" + input.zeout : '', JSON.stringify(input.names), c.code, '', new Date(), '', 'קופון: ' + c.owner]);
      var tickets = issueTickets_(orderId, 'קוד קופון', c.code, 0);
    } finally {
      lock.releaseLock();
    }
    notify_(orderId);
    return { ok: true, status: 'paid', clientToken: clientToken, tickets: tickets };
  }

  var amount = qty * CONFIG.TICKET_PRICE;
  sheet_(SHEETS.ORDERS).appendRow([orderId, clientToken, new Date(), 'pending', qty, amount, safeCell_(input.name), "'" + input.phone,
    input.email, input.zeout ? "'" + input.zeout : '', JSON.stringify(input.names), '', '', '', '', '']);

  var tx = nedarimCreateTransaction_({ amount: amount, orderId: orderId, input: input, qty: qty });
  setOrderFields_(orderId, function (row) { row[O.TXID - 1] = tx.transactionId; });
  return { ok: true, status: 'pending', clientToken: clientToken, transactionId: tx.transactionId, key: tx.key, amount: amount };
}

function nedarimCreateTransaction_(o) {
  var mosad = prop_('NEDARIM_MOSAD') || CONFIG.NEDARIM_MOSAD;
  var apiValid = prop_('NEDARIM_API_VALID') || CONFIG.NEDARIM_API_VALID;
  var callback = prop_('WEB_APP_URL');
  if (!mosad || !apiValid) throw userError_('הסליקה עדיין לא הוגדרה. אנא פנו למרכז חב"ד.');

  var parts = o.input.name.split(' ');
  var payload = {
    Mosad: mosad,
    ApiValid: apiValid,
    PaymentType: 'Ragil',
    Amount: String(o.amount),
    Currency: '1',
    Tashlumim: '1',
    Param2: o.orderId, // לא Param1 — Param1 חוסם ביט/העברה בקליק
    Groupe: CONFIG.NEDARIM_GROUPE,
    Comment: o.qty + ' כרטיסי הגרלה',
    FirstName: parts[0] || '',
    LastName: parts.slice(1).join(' '),
    Phone: o.input.phone,
    Mail: o.input.email || '',
    Zeout: o.input.zeout || ''
  };
  if (callback) payload.CallBack = callback;

  var res = UrlFetchApp.fetch(CONFIG.NEDARIM_CREATE_URL, { method: 'post', payload: payload, muteHttpExceptions: true });
  var text = res.getContentText();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (res.getResponseCode() !== 200 || data.Status !== 'OK') {
    log_('nedarim_create_error', text);
    setOrderFields_(o.orderId, function (row) { row[O.STATUS - 1] = 'failed'; row[O.NOTE - 1] = 'פתיחת עסקה נכשלה: ' + (data.Message || text).slice(0, 200); });
    throw userError_('לא ניתן לפתוח את דף התשלום כרגע' + (data.Message ? ' (' + data.Message + ')' : '') + '.');
  }
  return { transactionId: String(data.ID), key: String(data.Key) };
}

function findOrderRow_(col, value) {
  var sh = sheet_(SHEETS.ORDERS);
  var last = sh.getLastRow();
  if (last < 2 || !value) return null;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === String(value)) return i + 2;
  }
  return null;
}

function getOrder_(rowNum) {
  var row = sheet_(SHEETS.ORDERS).getRange(rowNum, 1, 1, HEADERS[SHEETS.ORDERS].length).getValues()[0];
  return {
    rowNum: rowNum, row: row, id: String(row[O.ID - 1]), clientToken: String(row[O.CLIENT - 1]), status: String(row[O.STATUS - 1]),
    qty: Number(row[O.QTY - 1]), amount: Number(row[O.AMOUNT - 1]), name: String(row[O.NAME - 1]),
    phone: String(row[O.PHONE - 1]).replace(/^'/, ''), email: String(row[O.EMAIL - 1]), zeout: String(row[O.ZEOUT - 1]).replace(/^'/, ''),
    names: JSON.parse(row[O.NAMES - 1] || '[]'), coupon: String(row[O.COUPON - 1]), txId: String(row[O.TXID - 1])
  };
}

function setOrderFields_(orderId, fn) {
  var rowNum = findOrderRow_(O.ID, orderId);
  if (!rowNum) return;
  var sh = sheet_(SHEETS.ORDERS);
  var range = sh.getRange(rowNum, 1, 1, HEADERS[SHEETS.ORDERS].length);
  var row = range.getValues()[0];
  fn(row);
  range.setValues([row]);
}

/** יוצר שורה נפרדת לכל כרטיס. חייב לרוץ בתוך נעילה. */
function issueTickets_(orderId, method, ref, pricePerTicket) {
  var order = getOrder_(findOrderRow_(O.ID, orderId));
  var sh = sheet_(SHEETS.TICKETS);
  var last = sh.getLastRow();
  var lastNum = CONFIG.FIRST_TICKET_NUMBER - 1;
  if (last >= 2) {
    var nums = sh.getRange(2, 1, last - 1, 1).getValues();
    nums.forEach(function (n) { if (Number(n[0]) > lastNum) lastNum = Number(n[0]); });
  }
  var now = new Date();
  var out = [];
  var rows = order.names.map(function (tName) {
    lastNum++;
    out.push({ ticketNum: lastNum, ticketName: tName });
    return [lastNum, fmtDate_(now), safeCell_(tName), safeCell_(order.name), "'" + order.phone, order.email,
      order.zeout ? "'" + order.zeout : '', method, ref, pricePerTicket, orderId.slice(0, 8)];
  });
  sh.getRange(last + 1, 1, rows.length, rows[0].length).setValues(rows);
  var range = out.length === 1 ? '#' + out[0].ticketNum : '#' + out[0].ticketNum + '-' + out[out.length - 1].ticketNum;
  setOrderFields_(orderId, function (row) { row[O.TICKETS - 1] = range; });
  return out;
}

function ticketsForOrder_(orderId) {
  var short = orderId.slice(0, 8);
  return rows_(SHEETS.TICKETS).filter(function (r) { return String(r[10]) === short; })
    .map(function (r) { return { ticketNum: r[0], ticketName: String(r[2]).replace(/^'/, '') }; });
}

function orderStatus_(body) {
  var rowNum = findOrderRow_(O.CLIENT, body.clientToken);
  if (!rowNum) throw userError_('ההזמנה לא נמצאה.');
  var order = getOrder_(rowNum);
  var res = { ok: true, status: order.status };
  if (order.status === 'paid') res.tickets = ticketsForOrder_(order.id);
  return res;
}

/** הדפדפן מדווח שנדרים החזיר OK — לתיעוד בלבד. האישור עצמו מגיע רק מה-CallBack. */
function clientConfirm_(body) {
  var rowNum = findOrderRow_(O.CLIENT, body.clientToken);
  if (!rowNum) return { ok: false };
  var order = getOrder_(rowNum);
  if (order.status === 'pending') {
    setOrderFields_(order.id, function (row) {
      row[O.NOTE - 1] = 'הדפדפן דיווח תשלום תקין (' + clean_(body.transactionId, 40) + ') ' + fmtDate_(new Date()) + ' — ממתין ל-CallBack';
    });
  }
  return { ok: true };
}

/* ======================= CallBack מנדרים פלוס ======================= */

function handleNedarimCallback_(p) {
  log_('nedarim_callback', JSON.stringify(p));
  var orderId = String(p.Param2 || '');
  var paid = Number(p.Amount);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var rowNum = findOrderRow_(O.ID, orderId);
    if (!rowNum) return { ok: true, processed: false, reason: 'order_not_found' };
    var order = getOrder_(rowNum);
    if (order.status === 'paid') return { ok: true, processed: false, reason: 'already_paid' };

    var status = String(p.Status || p.status || 'OK').toUpperCase();
    if (status === 'ERROR' || status === 'FAILED') {
      setOrderFields_(orderId, function (row) { row[O.STATUS - 1] = 'failed'; row[O.NOTE - 1] = 'נדרים: ' + clean_(p.Message, 200); });
      return { ok: true, processed: false, reason: 'payment_failed' };
    }
    if (!(paid > 0) || Math.abs(paid - order.amount) > 0.01) {
      setOrderFields_(orderId, function (row) { row[O.NOTE - 1] = 'סכום לא תואם ב-CallBack: ' + p.Amount + ' (צפוי ' + order.amount + ') — לבדיקה ידנית'; });
      return { ok: true, processed: false, reason: 'amount_mismatch' };
    }

    var txId = String(p.TransactionId || p.Confirmation || order.txId || '');
    setOrderFields_(orderId, function (row) {
      row[O.STATUS - 1] = 'paid'; row[O.PAID_AT - 1] = new Date(); if (txId) row[O.TXID - 1] = txId;
    });
    issueTickets_(orderId, 'אשראי - נדרים פלוס', txId || 'NP', CONFIG.TICKET_PRICE);
  } finally {
    lock.releaseLock();
  }
  notify_(orderId);
  return { ok: true, processed: true };
}

/* ======================= הודעות: SMS + מייל ======================= */

function notify_(orderId) {
  var order = getOrder_(findOrderRow_(O.ID, orderId));
  var tickets = ticketsForOrder_(orderId);
  try { sendSms_(order, tickets); } catch (e) { log_('sms_error', e.message); }
  try { sendEmail_(order, tickets); } catch (e) { log_('mail_error', e.message); }
}

function smsText_(order, tickets) {
  var list = tickets.map(function (t) { return '#' + t.ticketNum + ' ' + t.ticketName; }).join(', ');
  return 'שלום ' + order.name + ', הרישום להגרלת הענק בהתוועדות חג הגאולה י"ט כסלו של ' + CONFIG.ORG_NAME +
    ' אושר! הכרטיסים שלך: ' + list + '. ההתוועדות: יום שני כ\' כסלו 19:30, אולמי פאר בראשית. בהצלחה!';
}

function sendSms_(order, tickets) {
  var token = prop_('YEMOT_TOKEN');
  if (!token || !order.phone) return false;
  var payload = { token: token, phones: order.phone, message: smsText_(order, tickets) };
  var from = prop_('YEMOT_SMS_FROM');
  if (from) payload.from = from;
  var res = UrlFetchApp.fetch(CONFIG.YEMOT_SMS_URL, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var text = res.getContentText();
  var data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  var failed = data.errors && Object.keys(data.errors).length;
  if (data.responseStatus !== 'OK' || failed) {
    log_('sms_error', order.phone + ': ' + text);
    return false;
  }
  return true;
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sendEmail_(order, tickets) {
  if (!order.email) return;
  var cards = tickets.map(function (t) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:#7c0a18;border:2px solid #d4af37;border-radius:14px">' +
      '<tr><td style="padding:16px 18px;color:#fff;font-family:Arial,sans-serif;direction:rtl;text-align:right">' +
      '<div style="font-size:12px;color:#f3d27a;font-weight:bold">' + esc_(CONFIG.ORG_NAME) + ' • הגרלת חג הגאולה י"ט-כ\' כסלו</div>' +
      '<div style="font-size:22px;font-weight:bold;margin-top:4px">' + esc_(t.ticketName) + '</div>' +
      '<div style="font-size:12px;color:#fbe3c0;margin-top:4px">מזמין: ' + esc_(order.name) + '</div></td>' +
      '<td width="110" style="padding:12px;text-align:center"><div style="background:#f3d27a;border-radius:10px;padding:10px 6px;color:#4a0710;font-family:Arial,sans-serif">' +
      '<div style="font-size:11px;font-weight:bold">כרטיס מס\'</div><div style="font-size:26px;font-weight:900">#' + t.ticketNum + '</div></div></td></tr></table>';
  }).join('');

  var html = '<div style="background:#fdf8ee;padding:24px;direction:rtl;font-family:Arial,sans-serif;color:#2b1a12">' +
    '<div style="max-width:560px;margin:0 auto">' +
    '<h2 style="color:#7c0a18;margin:0 0 6px">הרישום להגרלה אושר! 🎉</h2>' +
    '<p style="margin:0 0 18px">שלום ' + esc_(order.name) + ', תודה על ההשתתפות בהגרלת הענק. אלו הכרטיסים שלך:</p>' + cards +
    '<p style="margin:18px 0 4px;font-weight:bold;color:#7c0a18">' + esc_(CONFIG.EVENT_TITLE) + '</p>' +
    '<p style="margin:0">' + esc_(CONFIG.EVENT_LINE) + '<br>סעודת הודיה כיד המלך • הכניסה חופשית • האירוע לגברים ונשים</p>' +
    '<p style="margin:18px 0 0;font-style:italic;color:#7c0a18">"מי ששמח בשמחתי אוציאנו מן המיצר למרחב בגשמיות וברוחניות"</p>' +
    '</div></div>';

  MailApp.sendEmail({
    to: order.email,
    subject: 'כרטיסי ההגרלה שלך • התוועדות חג הגאולה י"ט כסלו • ' + CONFIG.ORG_NAME,
    htmlBody: html,
    name: CONFIG.ORG_NAME
  });
}

/* ======================= ניהול ======================= */

function adminLogin_(body) {
  var pass = prop_('ADMIN_PASSWORD');
  if (!pass) throw userError_('הכניסה אינה זמינה כרגע.');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('admin_fails') || 0);
  if (fails >= 10) throw userError_('הכניסה נכשלה.');
  if (String(body.password || '') !== pass) {
    cache.put('admin_fails', String(fails + 1), 600);
    throw userError_('הכניסה נכשלה.');
  }
  var token = uuid_() + uuid_();
  cache.put('admin_' + token, '1', 21600); // 6 שעות
  return { ok: true, token: token };
}

function requireAdmin_(body) {
  if (!body.token || !CacheService.getScriptCache().get('admin_' + body.token)) {
    throw userError_('נדרשת כניסה מחדש לממשק הניהול.');
  }
}

function adminData_() {
  var tickets = rows_(SHEETS.TICKETS).map(function (r) {
    return {
      ticketNum: r[0], date: r[1] instanceof Date ? fmtDate_(r[1]) : String(r[1]), ticketName: String(r[2]).replace(/^'/, ''), payerName: String(r[3]).replace(/^'/, ''),
      phone: String(r[4]).replace(/^'/, ''), email: String(r[5]), zeout: String(r[6]).replace(/^'/, ''), method: String(r[7]),
      ref: String(r[8]), amount: Number(r[9]) || 0, order: String(r[10])
    };
  });
  var usage = {};
  tickets.forEach(function (t) { if (t.method === 'קוד קופון') usage[t.ref.toUpperCase()] = (usage[t.ref.toUpperCase()] || 0) + 1; });
  var coupons = rows_(SHEETS.COUPONS).map(function (r) {
    var code = String(r[1]).toUpperCase();
    return { owner: String(r[0]), code: code, limit: r[2] === '' ? null : Number(r[2]),
      active: r[3] === true || String(r[3]).toUpperCase() === 'TRUE', used: usage[code] || 0 };
  });
  var pending = rows_(SHEETS.ORDERS).filter(function (r) { return String(r[O.STATUS - 1]) === 'pending'; }).map(function (r) {
    return { orderId: String(r[0]), created: fmtDate_(new Date(r[O.CREATED - 1])), qty: r[O.QTY - 1], amount: r[O.AMOUNT - 1],
      name: String(r[O.NAME - 1]), phone: String(r[O.PHONE - 1]).replace(/^'/, ''), txId: String(r[O.TXID - 1]), note: String(r[O.NOTE - 1]) };
  }).reverse();
  return { ok: true, tickets: tickets, coupons: coupons, pending: pending, sheetUrl: ss_().getUrl(), open: isOpen_() };
}

function adminSetOpen_(body) {
  var open = body.open === true || body.open === 'true';
  PropertiesService.getScriptProperties().setProperty('REGISTRATION_OPEN', open ? 'yes' : 'no');
  log_('registration', open ? 'ההרשמה נפתחה' : 'ההרשמה נסגרה');
  return { ok: true, open: open };
}

function adminAddCoupon_(body) {
  var owner = clean_(body.owner, 60);
  var code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  var limit = body.limit === '' || body.limit == null ? '' : Math.max(1, parseInt(body.limit, 10) || 0);
  if (!owner || code.length < 3) throw userError_('יש להזין שם מורשה וקוד (3 תווים לפחות, אותיות לועזיות/ספרות).');
  if (findCoupon_(code)) throw userError_('קוד זה כבר קיים.');
  sheet_(SHEETS.COUPONS).appendRow([safeCell_(owner), code, limit, true, new Date()]);
  return { ok: true };
}

function adminToggleCoupon_(body) {
  var c = findCoupon_(body.code);
  if (!c) throw userError_('הקוד לא נמצא.');
  sheet_(SHEETS.COUPONS).getRange(c.row, 4).setValue(!c.active);
  return { ok: true };
}

/** אישור ידני של הזמנה שהתשלום עליה אומת בנדרים פלוס אבל ה-CallBack לא הגיע. */
function adminApproveOrder_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var rowNum = findOrderRow_(O.ID, body.orderId);
    if (!rowNum) throw userError_('ההזמנה לא נמצאה.');
    var order = getOrder_(rowNum);
    if (order.status === 'paid') throw userError_('ההזמנה כבר אושרה.');
    var ref = clean_(body.reference, 40) || order.txId || 'אישור ידני';
    setOrderFields_(order.id, function (row) {
      row[O.STATUS - 1] = 'paid'; row[O.PAID_AT - 1] = new Date();
      row[O.NOTE - 1] = (row[O.NOTE - 1] ? row[O.NOTE - 1] + ' | ' : '') + 'אושר ידנית בממשק הניהול';
    });
    issueTickets_(order.id, 'אשראי - נדרים פלוס', ref, CONFIG.TICKET_PRICE);
  } finally {
    lock.releaseLock();
  }
  notify_(body.orderId);
  return { ok: true };
}

function adminResendSms_(body) {
  var short = String(body.order || '');
  var rowsAll = rows_(SHEETS.ORDERS);
  for (var i = 0; i < rowsAll.length; i++) {
    if (String(rowsAll[i][0]).slice(0, 8) === short) {
      var order = getOrder_(i + 2);
      var ok = sendSms_(order, ticketsForOrder_(order.id));
      if (!ok) throw userError_('שליחת ה-SMS נכשלה.');
      return { ok: true };
    }
  }
  throw userError_('ההזמנה לא נמצאה.');
}
