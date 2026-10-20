/**
 * Apps Script لصفحة التسجيل — التكنوقراط السوريون
 * - يحفظ كل تسجيل كسطر في Google Sheet (عمود ثابت لكل حقل، قابل للتصفية)
 * - يمنع التكرار بنفس الجهاز أو نفس البريد الإلكتروني أو نفس رقم الهاتف
 * - يرسل تأكيد التسجيل إلى البريد الإلكتروني تلقائياً
 *
 * الإعداد: انظر README.md (قسم «إعداد Google Sheet و Apps Script»).
 */

/* ===================== الإعدادات ===================== */

const SHEET_NAME = 'التسجيلات';
const ID_PREFIX = 'OBR-';

// الحقول التي لا يُقبل تكرار قيمتها (إن وُجدت في الاستمارة)
const UNIQUE_KEYS = ['email', 'phone'];

// رسالة التأكيد بالبريد. نص الرسالة هنا على الخادم وليس في config.json،
// حتى لا يستطيع أحد إرسال رسائل بمحتوى من اختياره عبر الرابط.
const EMAIL = {
  enabled: true,
  senderName: 'مؤسسة التكنوقراط السوريون',
  replyTo: 'info@syriantechnocrats.org',
  subject: 'تأكيد تسجيلك في ملتقى عبور ٢٠٢٦ — {{id}}',
  // {{firstName}} {{lastName}} {{id}} {{role}} {{country}}
  html:
    '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.8;color:#13235B;max-width:560px">' +
    '<p>مرحباً {{firstName}}،</p>' +
    '<p>شكراً لتسجيلك في <strong>ملتقى عبور للابتكار والاستثمار ٢٠٢٦</strong>.</p>' +
    '<p style="background:#EEF3FA;border-radius:10px;padding:12px 16px;margin:16px 0">' +
    'رقم التسجيل: <strong dir="ltr">{{id}}</strong><br>' +
    'الاسم: {{firstName}} {{lastName}}<br>' +
    'الصفة: {{role}}</p>' +
    '<p>سنرسل إليك تفاصيل الموعد والمكان والبرنامج قبل الملتقى.</p>' +
    '<p>مع التحية،<br>فريق ملتقى عبور — مؤسسة التكنوقراط السوريون</p>' +
    '</div>',
};

/* ===================================================== */

const BASE_COLUMNS = [
  { key: '_id', label: 'رقم التسجيل' },
  { key: '_time', label: 'وقت التسجيل' },
];
const TECH_COLUMNS = [
  { key: '_emailStatus', label: 'حالة بريد التأكيد' },
  { key: '_phoneNormalized', label: 'الرقم (موحّد)' },
  { key: '_deviceId', label: 'معرّف الجهاز' },
  { key: '_fingerprint', label: 'بصمة الجهاز' },
  { key: '_userAgent', label: 'المتصفح' },
];
const HEADER_STYLE = { bg: '#13235B', fg: '#FFFFFF' };

function doGet() {
  return json_({ ok: true, service: 'sto-register' });
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'invalid' });
  }

  const fields = (Array.isArray(data.fields) ? data.fields : [])
    .filter(f => f && typeof f.key === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(f.key))
    .slice(0, 60);
  const deviceId = String(data.deviceId || '').slice(0, 100);
  const firstName = valueOf_(fields, 'firstName');
  const lastName = valueOf_(fields, 'lastName');
  const email = valueOf_(fields, 'email').toLowerCase();
  const phone = normalizePhone_(data.phoneNormalized || valueOf_(fields, 'phone'));

  if (!deviceId || !firstName || !lastName) return json_({ ok: false, error: 'invalid' });
  if (email && !isEmail_(email)) return json_({ ok: false, error: 'invalid' });
  if (phone && (phone.length < 8 || phone.length > 15)) return json_({ ok: false, error: 'invalid' });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }

  let regId, sheet, rowIndex, cols;
  try {
    sheet = getSheet_();
    cols = ensureColumns_(sheet, fields);

    // فحص التكرار
    const dup = findDuplicate_(sheet, cols, { deviceId: deviceId, email: email, phone: phone });
    if (dup) return json_({ ok: false, duplicate: true, reason: dup.reason, id: dup.id });

    const props = PropertiesService.getScriptProperties();
    const seq = Number(props.getProperty('seq') || '0') + 1;
    props.setProperty('seq', String(seq));
    regId = ID_PREFIX + String(seq).padStart(4, '0');

    const row = new Array(sheet.getLastColumn()).fill('');
    row[cols._id - 1] = regId;
    row[cols._time - 1] = new Date();
    fields.forEach(function (f) {
      if (cols[f.key]) row[cols[f.key] - 1] = cleanCell_(f.value);
    });
    if (cols.email && email) row[cols.email - 1] = email;
    row[cols._phoneNormalized - 1] = phone ? "'" + phone : '';
    row[cols._deviceId - 1] = deviceId;
    row[cols._fingerprint - 1] = String(data.fingerprint || '').slice(0, 50);
    row[cols._userAgent - 1] = String(data.userAgent || '').slice(0, 300);
    row[cols._emailStatus - 1] = EMAIL.enabled && email ? 'قيد الإرسال' : '—';

    sheet.appendRow(row);
    rowIndex = sheet.getLastRow();
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }

  // إرسال بريد التأكيد (خارج القفل)
  let emailSent = false;
  if (EMAIL.enabled && email) {
    let status;
    try {
      if (MailApp.getRemainingDailyQuota() < 1) {
        status = 'لم يُرسل: انتهت الحصة اليومية';
      } else {
        const vars = {
          id: regId, firstName: firstName, lastName: lastName,
          role: valueOf_(fields, 'role'), country: valueOf_(fields, 'country'),
        };
        MailApp.sendEmail({
          to: email,
          subject: fill_(EMAIL.subject, vars, false),
          htmlBody: fill_(EMAIL.html, vars, true),
          name: EMAIL.senderName,
          replyTo: EMAIL.replyTo || undefined,
        });
        emailSent = true;
        status = 'أُرسل';
      }
    } catch (err) {
      console.error(err);
      status = 'فشل الإرسال';
    }
    sheet.getRange(rowIndex, cols._emailStatus).setValue(status);
  }

  return json_({ ok: true, id: regId, emailSent: emailSent });
}

/* ---------- إعادة إرسال البريد للتسجيلات التي فشل إرسالها ----------
   شغّلها يدوياً من محرر Apps Script بعد تجدد الحصة اليومية. */
function resendFailedEmails() {
  const sheet = getSheet_();
  const cols = readColumnMap_(sheet);
  const n = sheet.getLastRow() - 1;
  if (n < 1 || !cols.email) return;
  const data = sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues();
  data.forEach(function (r, i) {
    const status = String(r[cols._emailStatus - 1]);
    if (status.indexOf('أُرسل') === 0 || status === '—') return;
    if (MailApp.getRemainingDailyQuota() < 1) return;
    const vars = {
      id: r[cols._id - 1], firstName: r[cols.firstName - 1], lastName: r[cols.lastName - 1],
      role: cols.role ? r[cols.role - 1] : '', country: cols.country ? r[cols.country - 1] : '',
    };
    try {
      MailApp.sendEmail({
        to: r[cols.email - 1], subject: fill_(EMAIL.subject, vars, false),
        htmlBody: fill_(EMAIL.html, vars, true), name: EMAIL.senderName, replyTo: EMAIL.replyTo || undefined,
      });
      sheet.getRange(i + 2, cols._emailStatus).setValue('أُرسل (إعادة)');
    } catch (err) {
      sheet.getRange(i + 2, cols._emailStatus).setValue('فشل الإرسال');
    }
  });
}

/* ---------- أدوات ---------- */

function findDuplicate_(sheet, cols, keys) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) return null;
  const read = function (c) { return c ? sheet.getRange(2, c, n, 1).getValues() : null; };
  const ids = read(cols._id);
  const devices = read(cols._deviceId);
  const uniques = {};
  UNIQUE_KEYS.forEach(function (k) {
    if (k === 'phone') uniques.phone = read(cols._phoneNormalized);
    else if (cols[k]) uniques[k] = read(cols[k]);
  });
  for (let i = 0; i < n; i++) {
    if (devices && String(devices[i][0]) === keys.deviceId) return { reason: 'device', id: String(ids[i][0]) };
    if (keys.email && uniques.email && String(uniques.email[i][0]).trim().toLowerCase() === keys.email) {
      return { reason: 'email', id: String(ids[i][0]) };
    }
    if (keys.phone && uniques.phone && normalizePhone_(uniques.phone[i][0]) === keys.phone) {
      return { reason: 'phone', id: String(ids[i][0]) };
    }
  }
  return null;
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.setRightToLeft(true);
  }
  return sheet;
}

function styleHeader_(range) {
  range.setFontWeight('bold').setBackground(HEADER_STYLE.bg).setFontColor(HEADER_STYLE.fg);
}

/**
 * يضمن وجود عمود لكل حقل. أي حقل جديد في config.json يُضاف تلقائياً كعمود
 * قبل الأعمدة التقنية. مفتاح كل عمود محفوظ كملاحظة (note) على خلية العنوان.
 */
function ensureColumns_(sheet, fields) {
  if (sheet.getLastColumn() === 0) {
    const initial = BASE_COLUMNS.concat(TECH_COLUMNS);
    const r = sheet.getRange(1, 1, 1, initial.length);
    r.setValues([initial.map(c => c.label)]).setNotes([initial.map(c => c.key)]);
    styleHeader_(r);
    sheet.setFrozenRows(1);
  }
  let map = readColumnMap_(sheet);

  // أعمدة تقنية ناقصة (من نسخة أقدم) تُضاف في النهاية
  TECH_COLUMNS.forEach(function (c) {
    if (map[c.key]) return;
    const col = sheet.getLastColumn() + 1;
    const r = sheet.getRange(1, col);
    r.setValue(c.label).setNote(c.key);
    styleHeader_(r);
    map = readColumnMap_(sheet);
  });

  const firstTech = function () {
    return Math.min.apply(null, TECH_COLUMNS.map(c => map[c.key]));
  };

  fields.forEach(function (f) {
    if (map[f.key]) return;
    const at = firstTech();
    sheet.insertColumnBefore(at);
    const r = sheet.getRange(1, at);
    r.setValue(String(f.label || f.key).slice(0, 100)).setNote(f.key);
    styleHeader_(r);
    map = readColumnMap_(sheet);
  });

  return map;
}

function readColumnMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return {};
  const notes = sheet.getRange(1, 1, 1, lastCol).getNotes()[0];
  const map = {};
  notes.forEach(function (k, i) { if (k) map[k] = i + 1; });
  return map;
}

function valueOf_(fields, key) {
  const f = fields.find(x => x.key === key);
  return f ? String(f.value || '').trim().slice(0, 200) : '';
}

function isEmail_(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function normalizePhone_(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  return d;
}

// يمنع حقن الصيغ في Google Sheets
function cleanCell_(v) {
  const s = String(v == null ? '' : v).slice(0, 2000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fill_(tpl, vars, html) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (_, k) {
    const v = vars[k] == null ? '' : vars[k];
    return html ? escapeHtml_(v) : String(v);
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
