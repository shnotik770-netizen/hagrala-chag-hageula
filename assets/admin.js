(function () {
  'use strict';
  var CFG = window.HAGRALA_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var KEY = 'hagrala_admin_token';

  function getToken() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {} }

  function api(action, extra) {
    var body = Object.assign({ action: action, token: getToken() }, extra || {});
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.ok === false) {
          var msg = (res && res.error) || 'שגיאה';
          if (/כניסה מחדש/.test(msg)) logout();
          throw new Error(msg);
        }
        return res;
      });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function login(ev) {
    ev.preventDefault();
    $('login-err').hidden = true;
    $('login-btn').disabled = true;
    api('adminLogin', { password: $('pass').value })
      .then(function (res) { setToken(res.token); showDash(); })
      .catch(function (e) { $('login-err').textContent = e.message; $('login-err').hidden = false; })
      .finally(function () { $('login-btn').disabled = false; });
  }

  function logout() {
    setToken(null);
    $('dash').hidden = true;
    $('login').hidden = false;
    $('logout').hidden = true;
  }

  function showDash() {
    $('login').hidden = true;
    $('dash').hidden = false;
    $('logout').hidden = false;
    load();
  }

  function load() {
    $('refresh').disabled = true;
    return api('adminData').then(function (res) { data = res; render(); })
      .catch(function (e) { alertBox(e.message); })
      .finally(function () { $('refresh').disabled = false; });
  }

  function alertBox(msg) { console.warn(msg); window.setTimeout(function () { window.alert(msg); }, 0); }

  function render() {
    var t = data.tickets;
    $('st-tickets').textContent = t.length;
    $('st-revenue').textContent = t.reduce(function (s, x) { return s + (x.amount || 0); }, 0).toLocaleString('he-IL') + ' ₪';
    $('st-coupon').textContent = t.filter(function (x) { return x.method === 'קוד קופון'; }).length;
    $('st-pending').textContent = data.pending.length;
    $('sheet-link').href = data.sheetUrl;
    renderOpen(data.open !== false);
    if (document.activeElement !== $('closed-msg-input')) $('closed-msg-input').value = data.closedMessage || '';

    // pending
    $('pending-card').hidden = !data.pending.length;
    $('pending-body').innerHTML = data.pending.map(function (p) {
      return '<tr><td>' + esc(p.created) + '</td><td>' + esc(p.name) + '</td><td class="ltr">' + esc(p.phone) + '</td><td>' + esc(p.qty) +
        '</td><td>' + esc(p.amount) + ' ₪</td><td class="ltr">' + esc(p.txId) + '</td><td style="font-size:12px;color:#7a6656;max-width:260px">' + esc(p.note) +
        '</td><td><button class="btn light" data-approve="' + esc(p.orderId) + '">אשר ידנית</button></td></tr>';
    }).join('');

    // coupons
    $('coupons-body').innerHTML = data.coupons.map(function (c) {
      return '<tr><td><b>' + esc(c.owner) + '</b></td><td><span class="pill cp ltr">' + esc(c.code) + '</span></td><td><b>' + c.used + '</b></td><td>' +
        (c.limit ? esc(c.limit) : 'ללא הגבלה') + '</td><td><span class="pill ' + (c.active ? 'on">פעיל' : 'off">מושהה') + '</span></td>' +
        '<td><button class="btn light" data-toggle="' + esc(c.code) + '">' + (c.active ? 'השהה' : 'הפעל') + '</button></td></tr>';
    }).join('') || '<tr><td colspan="6">אין עדיין קודים.</td></tr>';

    renderTickets();
  }

  function renderOpen(open) {
    $('reg-state').textContent = open ? '● ההרשמה פתוחה' : '● ההרשמה סגורה';
    $('reg-state').className = 'state ' + (open ? 'on' : 'off');
    $('reg-btn').textContent = open ? 'עצירת ההרשמה' : 'פתיחת ההרשמה מחדש';
    $('reg-btn').className = 'btn ' + (open ? 'red' : 'green');
    $('reg-btn').dataset.open = open ? '1' : '0';
    $('reg-btn').disabled = false;
  }

  function toggleOpen() {
    var open = $('reg-btn').dataset.open === '1';
    if (open && !window.confirm('לעצור את ההרשמה להגרלה באתר? הטופס יוסתר מהגולשים.')) return;
    $('reg-btn').disabled = true;
    api('adminSetOpen', { open: !open, message: $('closed-msg-input').value }).then(function (res) { data.open = res.open; renderOpen(res.open); })
      .catch(function (e) { alertBox(e.message); $('reg-btn').disabled = false; });
  }

  function renderTickets() {
    var q = $('search').value.trim().toLowerCase();
    var list = data.tickets.filter(function (x) {
      return !q || String(x.ticketNum).indexOf(q) > -1 || x.ticketName.toLowerCase().indexOf(q) > -1 ||
        x.payerName.toLowerCase().indexOf(q) > -1 || x.phone.replace(/\D/g, '').indexOf(q.replace(/\D/g, '') || '§') > -1 ||
        x.ref.toLowerCase().indexOf(q) > -1;
    }).slice().reverse();
    $('tickets-body').innerHTML = list.map(function (x) {
      var cp = x.method === 'קוד קופון';
      return '<tr><td><b style="color:var(--maroon)">#' + esc(x.ticketNum) + '</b></td><td style="white-space:nowrap">' + esc(x.date) + '</td><td><b>' + esc(x.ticketName) +
        '</b></td><td>' + esc(x.payerName) + '</td><td class="ltr">' + esc(x.phone) + '</td><td style="font-size:12px">' + esc(x.email || '-') +
        '</td><td><span class="pill ' + (cp ? 'cp' : 'cc') + '">' + esc(cp ? 'קוד ' + x.ref : 'אשראי ' + x.ref) + '</span></td><td>' + esc(x.amount) + ' ₪</td>' +
        '<td><button class="btn light" style="padding:4px 8px;font-size:12px" data-sms="' + esc(x.order) + '" title="שליחת SMS חוזרת למזמין">SMS</button></td></tr>';
    }).join('') || '<tr><td colspan="9">אין עדיין כרטיסים.</td></tr>';
  }

  function csv() {
    var head = ['מספר כרטיס', 'תאריך', 'שם על הכרטיס', 'שם המשלם', 'טלפון', 'אימייל', 'תעודת זהות', 'אופן רישום', 'אסמכתא', 'סכום'];
    var rows = data.tickets.map(function (x) { return [x.ticketNum, x.date, x.ticketName, x.payerName, x.phone, x.email, x.zeout, x.method, x.ref, x.amount]; });
    var text = '﻿' + [head].concat(rows).map(function (r) {
      return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = 'הגרלת_יט_כסלו_חבד_עפולה.csv';
    a.click();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.toggle) {
      b.disabled = true;
      api('adminToggleCoupon', { code: b.dataset.toggle }).then(load).catch(function (er) { alertBox(er.message); b.disabled = false; });
    } else if (b.dataset.approve) {
      var ref = window.prompt('אישור ידני: הזינו את מספר האסמכתא מנדרים פלוס (אחרי שבדקתם שהתשלום עבר):');
      if (ref === null) return;
      b.disabled = true;
      api('adminApproveOrder', { orderId: b.dataset.approve, reference: ref }).then(load).catch(function (er) { alertBox(er.message); b.disabled = false; });
    } else if (b.dataset.sms) {
      if (!window.confirm('לשלוח שוב SMS עם כל כרטיסי ההזמנה למזמין?')) return;
      b.disabled = true;
      api('adminResendSms', { order: b.dataset.sms }).then(function () { b.textContent = '✓'; })
        .catch(function (er) { alertBox(er.message); b.disabled = false; });
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    $('login').addEventListener('submit', login);
    $('logout').onclick = function (e) { e.preventDefault(); logout(); };
    $('refresh').onclick = load;
    $('reg-btn').onclick = toggleOpen;
    $('closed-msg-save').onclick = function () {
      var b = this; b.disabled = true;
      api('adminSetOpen', { open: $('reg-btn').dataset.open === '1', message: $('closed-msg-input').value })
        .then(function (res) { $('closed-msg-input').value = res.closedMessage; b.textContent = '✓ נשמר'; setTimeout(function () { b.textContent = 'שמירת ההודעה'; }, 1500); })
        .catch(function (e) { alertBox(e.message); }).finally(function () { b.disabled = false; });
    };
    $('csv').onclick = csv;
    $('search').addEventListener('input', renderTickets);
    $('add-coupon').addEventListener('submit', function (e) {
      e.preventDefault();
      api('adminAddCoupon', { owner: $('c-owner').value, code: $('c-code').value, limit: $('c-limit').value })
        .then(function () { $('add-coupon').reset(); load(); })
        .catch(function (er) { alertBox(er.message); });
    });
    if (getToken()) showDash();
  });
})();
