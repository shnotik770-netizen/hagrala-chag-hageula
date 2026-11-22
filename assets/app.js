(function () {
  'use strict';

  var CFG = window.HAGRALA_CONFIG || {};
  var PRICE = CFG.TICKET_PRICE || 25;
  var MAX = CFG.MAX_TICKETS || 30;
  var NEDARIM_SRC = 'https://www.matara.pro/nedarimplus/iframe/v3/?language=he';

  var state = { qty: 1, coupon: null, clientToken: null, paying: false };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- API ---------------- */
  function api(action, data) {
    if (!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) {
      return Promise.reject(new Error('האתר עדיין לא חובר לשרת (API_URL ב-config.js).'));
    }
    var body = Object.assign({ action: action }, data || {});
    // text/plain — בלי preflight, כך ש-Apps Script מקבל את הבקשה ישירות
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .catch(function () { throw new Error('בעיית תקשורת. בדקו את החיבור ונסו שוב.'); })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || 'אירעה שגיאה.');
        return res;
      });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- כמות ושמות ---------------- */
  function setQty(n) {
    state.qty = Math.max(1, Math.min(MAX, n));
    $('qty').textContent = state.qty;
    document.querySelectorAll('#quick button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.q) === state.qty));
    });
    renderNames();
    if (state.coupon) { // מכסת קופון תלויה בכמות — מאמתים מחדש
      state.coupon = null;
      setCouponMsg('הכמות השתנתה — יש ללחוץ שוב על "החל"', 'err');
    }
    updateSummary();
  }

  function renderNames() {
    var box = $('names');
    var current = Array.prototype.map.call(box.querySelectorAll('input'), function (i) { return i.value; });
    if (!current[0]) current[0] = $('payer-name').value.trim();
    box.innerHTML = '';
    for (var i = 0; i < state.qty; i++) {
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="badge">#' + (i + 1) + '</span>';
      var inp = document.createElement('input');
      inp.className = 'ticket-name';
      inp.placeholder = 'שם מלא לכרטיס #' + (i + 1);
      inp.maxLength = 60;
      inp.value = current[i] || '';
      inp.setAttribute('aria-label', 'שם על כרטיס ' + (i + 1));
      if (i === 0) inp.addEventListener('input', function () { this.dataset.edited = '1'; });
      row.appendChild(inp);
      box.appendChild(row);
    }
  }

  function updateSummary() {
    var total = state.qty * PRICE;
    $('sum-qty').textContent = state.qty;
    if (state.coupon) {
      $('sum-disc-row').hidden = false;
      $('sum-disc').textContent = '−' + total + ' ₪ (' + state.coupon.code + ')';
      $('sum-total').textContent = '0 ₪';
      $('submit-text').textContent = 'רישום ' + state.qty + (state.qty === 1 ? ' כרטיס' : ' כרטיסים') + ' ללא חיוב';
    } else {
      $('sum-disc-row').hidden = true;
      $('sum-total').textContent = total + ' ₪';
      $('submit-text').textContent = 'המשך לתשלום מאובטח • ' + total + ' ₪';
    }
  }

  /* ---------------- קופון ---------------- */
  function setCouponMsg(text, kind) {
    var m = $('coupon-msg');
    m.textContent = text;
    m.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function applyCoupon() {
    var code = $('coupon').value.trim().toUpperCase();
    state.coupon = null;
    updateSummary();
    if (!code) { setCouponMsg('', ''); return; }
    var btn = $('apply-coupon');
    btn.disabled = true;
    setCouponMsg('בודק…', '');
    api('checkCoupon', { code: code, qty: state.qty })
      .then(function (res) {
        state.coupon = { code: res.code, owner: res.owner };
        setCouponMsg('✓ הקוד אושר (' + res.owner + ') — רישום ללא חיוב', 'ok');
        updateSummary();
      })
      .catch(function (e) { setCouponMsg('✗ ' + e.message, 'err'); })
      .finally(function () { btn.disabled = false; });
  }

  /* ---------------- ולידציה ---------------- */
  function showError(msg, el) {
    var box = $('form-error');
    box.textContent = msg;
    box.hidden = false;
    if (el) { el.classList.add('invalid'); el.focus(); }
  }

  function collect() {
    $('form-error').hidden = true;
    document.querySelectorAll('.invalid').forEach(function (e) { e.classList.remove('invalid'); });
    var name = $('payer-name').value.trim();
    var phone = $('payer-phone').value.trim();
    var email = $('payer-email').value.trim();
    var zeout = $('payer-id').value.replace(/\D/g, '');
    var digits = phone.replace(/\D/g, '').replace(/^972/, '0');

    if (name.length < 2) return showError('נא להזין שם מלא של המזמין.', $('payer-name'));
    if (!/^0\d{8,9}$/.test(digits)) return showError('נא להזין מספר טלפון נייד תקין.', $('payer-phone'));
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('כתובת המייל אינה תקינה.', $('payer-email'));
    if (zeout && zeout.length !== 9) return showError('תעודת זהות צריכה להכיל 9 ספרות (או להשאיר ריק).', $('payer-id'));

    var names = [];
    var inputs = document.querySelectorAll('.ticket-name');
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim();
      if (!v) return showError('נא להזין שם עבור כרטיס #' + (i + 1) + '.', inputs[i]);
      names.push(v);
    }
    return { payerName: name, payerPhone: digits, payerEmail: email, payerId: zeout, ticketNames: names };
  }

  /* ---------------- שליחה ---------------- */
  function setBusy(b, text) {
    state.paying = b;
    $('submit').disabled = b;
    if (text) $('submit-text').textContent = text;
    if (!b) updateSummary();
  }

  function submit(ev) {
    ev.preventDefault();
    if (state.paying) return;
    var data = collect();
    if (!data) return;
    if (state.coupon) data.coupon = state.coupon.code;

    setBusy(true, state.coupon ? 'רושם את הכרטיסים…' : 'פותח דף תשלום מאובטח…');
    api('createOrder', data)
      .then(function (res) {
        state.clientToken = res.clientToken;
        if (res.status === 'paid') {
          setBusy(false);
          showDone(res.tickets, data, 'הכרטיסים נרשמו בהצלחה' + (data.payerEmail ? ' ונשלחו גם למייל' : '') + '. אישור יישלח ב-SMS.');
          resetForm();
        } else {
          openPayment(res, data);
        }
      })
      .catch(function (e) { setBusy(false); showError(e.message); });
  }

  /* ---------------- נדרים פלוס ---------------- */
  var frame, frameReady = false, pendingStart = null;

  function initFrame() {
    frame = $('NedarimFrame');
    window.addEventListener('message', function (event) {
      if (!/(^|\.)matara\.pro$/.test(new URL(event.origin || 'http://x').hostname)) return;
      var msg = event.data || {};
      if (msg.Name === 'Height') {
        frame.style.height = (parseInt(msg.Value, 10) + 15) + 'px';
        if (!frameReady) {
          frameReady = true;
          if (pendingStart) { postNedarim(pendingStart); pendingStart = null; }
        }
      } else if (msg.Name === 'TransactionResponse') {
        onTransactionResponse(msg.Value || {});
      }
    });
  }

  function postNedarim(data) {
    frame.contentWindow.postMessage(data, 'https://www.matara.pro');
  }

  function loadFrame() {
    frameReady = false;
    frame.style.height = '0px';
    frame.src = NEDARIM_SRC + '&t=' + Date.now();
  }

  function openPayment(res, data) {
    $('pay-for').textContent = data.ticketNames.length + (data.ticketNames.length === 1 ? ' כרטיס הגרלה' : ' כרטיסי הגרלה');
    $('pay-amount').textContent = res.amount + ' ₪';
    $('pay-error').hidden = true;
    $('pay-loading').hidden = false;
    $('pay-modal').classList.add('open');
    state.lastOrderData = data;
    var start = { Name: 'StartPayment', Value: { TransactionId: res.transactionId, Key: res.key, ButtonText: 'תשלום ' + res.amount + ' ₪' } };
    loadFrame();
    pendingStart = start;
    var hideLoading = setInterval(function () { if (frameReady) { $('pay-loading').hidden = true; clearInterval(hideLoading); } }, 200);
  }

  function closePayment() {
    $('pay-modal').classList.remove('open');
    frame.src = 'about:blank';
    frameReady = false;
    setBusy(false);
  }

  function onTransactionResponse(v) {
    if (v.Status === 'OK') {
      frame.style.height = '0px';
      $('pay-loading').hidden = false;
      $('pay-loading').innerHTML = '<div class="spinner"></div>התשלום התקבל! מנפיק את הכרטיסים…';
      api('clientConfirm', { clientToken: state.clientToken, transactionId: v.TransactionId || '' }).catch(function () {});
      waitForTickets(0);
    } else {
      var err = $('pay-error');
      err.textContent = (v.Message || 'התשלום לא הושלם.') + ' ניתן לנסות שוב או לסגור ולפנות אלינו.';
      err.hidden = false;
    }
  }

  // האישור הסופי מגיע מנדרים פלוס ישירות לשרת (CallBack). ממתינים לו עד כדקה.
  function waitForTickets(attempt) {
    api('orderStatus', { clientToken: state.clientToken })
      .then(function (res) {
        if (res.status === 'paid') {
          finishPaid(res.tickets, 'התשלום התקבל והכרטיסים נרשמו. אישור נשלח ב-SMS' + (state.lastOrderData.payerEmail ? ' ובמייל' : '') + '.');
        } else if (attempt < 25) {
          setTimeout(function () { waitForTickets(attempt + 1); }, 2500);
        } else {
          finishPaid(null, 'התשלום התקבל בהצלחה. מספרי הכרטיסים יישלחו אליך ב-SMS בדקות הקרובות. לבירורים: 054-6510770.');
        }
      })
      .catch(function () {
        if (attempt < 25) setTimeout(function () { waitForTickets(attempt + 1); }, 2500);
        else finishPaid(null, 'התשלום התקבל. מספרי הכרטיסים יישלחו אליך ב-SMS. לבירורים: 054-6510770.');
      });
  }

  function finishPaid(tickets, note) {
    $('pay-modal').classList.remove('open');
    $('pay-loading').innerHTML = '<div class="spinner"></div>טוען את דף התשלום המאובטח…';
    frame.src = 'about:blank';
    setBusy(false);
    showDone(tickets, state.lastOrderData, note);
    resetForm();
  }

  /* ---------------- אישור ---------------- */
  function showDone(tickets, data, note) {
    var html = '';
    (tickets || []).forEach(function (t) {
      html += '<div class="ticket"><div><small>מרכז חב"ד עפולה • הגרלת חג הגאולה י"ט-כ\' כסלו</small>' +
        '<b>' + esc(t.ticketName) + '</b><small style="color:#fbe3c0">מזמין: ' + esc(data.payerName) + '</small></div>' +
        '<div class="no"><small>כרטיס מס\'</small><strong>#' + esc(t.ticketNum) + '</strong></div></div>';
    });
    $('done-tickets').innerHTML = html;
    $('done-note').textContent = note;
    $('done-modal').classList.add('open');
  }

  function resetForm() {
    state.coupon = null;
    $('coupon').value = '';
    setCouponMsg('', '');
    $('names').innerHTML = '';
    setQty(1);
  }

  /* ---------------- אתחול ---------------- */
  function init() {
    initFrame();
    renderNames();
    updateSummary();

    $('qty-minus').onclick = function () { setQty(state.qty - 1); };
    $('qty-plus').onclick = function () { setQty(state.qty + 1); };
    document.querySelectorAll('#quick button').forEach(function (b) {
      b.onclick = function () { setQty(Number(b.dataset.q)); };
    });
    $('payer-name').addEventListener('input', function () {
      var first = document.querySelector('.ticket-name');
      if (first && !first.dataset.edited) first.value = this.value;
    });
    $('fill-all').onclick = function () {
      var n = $('payer-name').value.trim();
      if (!n) return showError('נא להזין קודם את שם המזמין.', $('payer-name'));
      document.querySelectorAll('.ticket-name').forEach(function (i) { i.value = n; });
    };
    $('apply-coupon').onclick = applyCoupon;
    $('coupon').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } });
    $('order-form').addEventListener('submit', submit);
    $('pay-close').onclick = closePayment;
    $('done-close').onclick = function () { $('done-modal').classList.remove('open'); };
    $('done-again').onclick = function () { $('done-modal').classList.remove('open'); $('buy').scrollIntoView({ behavior: 'smooth' }); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('done-modal').classList.contains('open')) $('done-modal').classList.remove('open');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
