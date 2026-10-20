#!/usr/bin/env python3
"""
خادم التسجيل — التكنوقراط السوريون
بايثون 3.9+ فقط، بدون أي مكتبات خارجية.

- يستقبل التسجيلات من صفحة GitHub Pages
- يحفظها في SQLite على الخادم
- يمنع التكرار (نفس الجهاز / نفس البريد / نفس الهاتف)
- يرسل بريد التأكيد عبر خادم Infomaniak من info@syrian-technocrats.org
- صفحة إدارة محمية بكلمة سر لتنزيل التسجيلات كملف Excel

التشغيل:      python3 server.py
إعادة البريد:  python3 server.py resend
تجربة البريد:  python3 server.py testmail you@example.com
"""
import base64
import hmac
import html
import io
import json
import os
import re
import smtplib
import sqlite3
import ssl
import sys
import threading
import time
import zipfile
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from xml.sax.saxutils import escape as xml_escape

BASE = os.path.dirname(os.path.abspath(__file__))


# ======================== الإعدادات ========================

def load_env(path):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


load_env(os.path.join(BASE, ".env"))


def env(k, default=""):
    return os.environ.get(k, default)


CFG = {
    "host": env("HOST", "0.0.0.0"),
    "port": int(env("PORT", "8080")),
    "db": env("DB_PATH", os.path.join(BASE, "data", "registrations.db")),
    "origins": [o.strip().rstrip("/") for o in env("ALLOWED_ORIGINS", "https://syriantechnocrats.github.io").split(",") if o.strip()],
    "id_prefix": env("ID_PREFIX", "OBR-"),
    "event": env("EVENT_ID", "oboor2026"),
    "trust_proxy": env("TRUST_PROXY", "1") == "1",
    "smtp_host": env("SMTP_HOST", "mail.infomaniak.com"),
    "smtp_port": int(env("SMTP_PORT", "465")),
    "smtp_user": env("SMTP_USER", "info@syrian-technocrats.org"),
    "smtp_pass": env("SMTP_PASS", ""),
    "smtp_tls": env("SMTP_TLS", "ssl"),  # ssl (منفذ 465) | starttls (منفذ 587) | none (للتجربة المحلية فقط)
    "mail_from": env("MAIL_FROM", "info@syrian-technocrats.org"),
    "mail_from_name": env("MAIL_FROM_NAME", "مؤسسة التكنوقراط السوريون"),
    "mail_reply_to": env("MAIL_REPLY_TO", "info@syrian-technocrats.org"),
    "mail_subject": env("MAIL_SUBJECT", "تأكيد تسجيلك في ملتقى عبور ٢٠٢٦ — {{id}}"),
    "mail_enabled": env("MAIL_ENABLED", "1") == "1",
    "admin_user": env("ADMIN_USER", "admin"),
    "admin_pass": env("ADMIN_PASS", ""),
    "rate_limit": int(env("RATE_LIMIT_PER_10MIN", "20")),
}

UNIQUE_KEYS = ("email", "phone")
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
MAX_BODY = 64 * 1024

TEMPLATE_PATH = os.path.join(BASE, "email_template.html")


def now_iso():
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def log(*a):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


# ======================== قاعدة البيانات ========================

DB_LOCK = threading.Lock()


def db():
    os.makedirs(os.path.dirname(CFG["db"]), exist_ok=True)
    con = sqlite3.connect(CFG["db"], timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db():
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS registrations (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              reg_id TEXT UNIQUE NOT NULL,
              event TEXT NOT NULL,
              created_at TEXT NOT NULL,
              device_id TEXT NOT NULL,
              email TEXT,
              phone TEXT,
              first_name TEXT,
              last_name TEXT,
              fields_json TEXT NOT NULL,
              fingerprint TEXT,
              user_agent TEXT,
              ip TEXT,
              email_status TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_device ON registrations(event, device_id);
            CREATE UNIQUE INDEX IF NOT EXISTS ux_email ON registrations(event, email) WHERE email IS NOT NULL AND email <> '';
            CREATE UNIQUE INDEX IF NOT EXISTS ux_phone ON registrations(event, phone) WHERE phone IS NOT NULL AND phone <> '';
            CREATE TABLE IF NOT EXISTS columns (
              key TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              ord INTEGER NOT NULL
            );
            """
        )


def normalize_phone(v):
    d = re.sub(r"\D", "", str(v or ""))
    return d[2:] if d.startswith("00") else d


def clean(v, n=2000):
    return str("" if v is None else v)[:n]


def register(data, ip):
    fields = [f for f in (data.get("fields") or []) if isinstance(f, dict) and KEY_RE.match(str(f.get("key", "")))][:60]
    by_key = {f["key"]: clean(f.get("value")).strip() for f in fields}
    device = clean(data.get("deviceId"), 100).strip()
    first, last = by_key.get("firstName", "")[:200], by_key.get("lastName", "")[:200]
    email = by_key.get("email", "").lower()[:200]
    phone = normalize_phone(data.get("phoneNormalized") or by_key.get("phone", ""))

    if not device or not first or not last:
        return {"ok": False, "error": "invalid"}
    if email and not EMAIL_RE.match(email):
        return {"ok": False, "error": "invalid"}
    if phone and not (8 <= len(phone) <= 15):
        return {"ok": False, "error": "invalid"}
    if email:
        by_key["email"] = email

    event = clean(data.get("eventId"), 60) or CFG["event"]

    with DB_LOCK, db() as con:
        # فحص التكرار
        checks = [("device", "device_id", device), ("email", "email", email), ("phone", "phone", phone)]
        for reason, col, val in checks:
            if not val:
                continue
            row = con.execute(f"SELECT reg_id FROM registrations WHERE event=? AND {col}=?", (event, val)).fetchone()
            if row:
                return {"ok": False, "duplicate": True, "reason": reason, "id": row["reg_id"]}

        # تسجيل الأعمدة الجديدة بترتيب ظهورها
        known = {r["key"] for r in con.execute("SELECT key FROM columns")}
        nxt = con.execute("SELECT COALESCE(MAX(ord),0) FROM columns").fetchone()[0]
        for f in fields:
            label = clean(f.get("label") or f["key"], 100)
            if f["key"] not in known:
                nxt += 1
                con.execute("INSERT INTO columns(key,label,ord) VALUES(?,?,?)", (f["key"], label, nxt))
                known.add(f["key"])
            else:
                con.execute("UPDATE columns SET label=? WHERE key=?", (label, f["key"]))

        cur = con.execute(
            """INSERT INTO registrations(reg_id,event,created_at,device_id,email,phone,first_name,last_name,
               fields_json,fingerprint,user_agent,ip,email_status)
               VALUES('',?,?,?,?,?,?,?,?,?,?,?,?)""",
            (event, now_iso(), device, email or None, phone or None, first, last,
             json.dumps(by_key, ensure_ascii=False), clean(data.get("fingerprint"), 50),
             clean(data.get("userAgent"), 300), ip,
             "قيد الإرسال" if (CFG["mail_enabled"] and email) else "—"),
        )
        seq = cur.lastrowid
        reg_id = f"{CFG['id_prefix']}{seq:04d}"
        con.execute("UPDATE registrations SET reg_id=? WHERE seq=?", (reg_id, seq))

    if CFG["mail_enabled"] and email:
        threading.Thread(target=send_and_record, args=(seq,), daemon=True).start()

    log("registered", reg_id)
    return {"ok": True, "id": reg_id, "emailSent": bool(CFG["mail_enabled"] and email)}


# ======================== البريد ========================

def fill(tpl, vars_, escape_html):
    def rep(m):
        v = vars_.get(m.group(1), "")
        return html.escape(str(v)) if escape_html else str(v)
    return re.sub(r"\{\{(\w+)\}\}", rep, tpl)


def load_template():
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        return f.read()


def send_mail(to, vars_):
    if not CFG["smtp_pass"]:
        raise RuntimeError("SMTP_PASS غير مضبوط في .env")
    body_html = fill(load_template(), vars_, True)
    text = re.sub(r"<br\s*/?>", "\n", body_html)
    text = re.sub(r"</p>", "\n\n", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()

    msg = EmailMessage()
    msg["Subject"] = fill(CFG["mail_subject"], vars_, False)
    msg["From"] = formataddr((CFG["mail_from_name"], CFG["mail_from"]))
    msg["To"] = to
    if CFG["mail_reply_to"]:
        msg["Reply-To"] = CFG["mail_reply_to"]
    msg["Message-ID"] = make_msgid(domain=CFG["mail_from"].split("@")[-1])
    msg.set_content(text)
    msg.add_alternative(body_html, subtype="html")

    ctx = ssl.create_default_context()
    if CFG["smtp_tls"] == "none":
        with smtplib.SMTP(CFG["smtp_host"], CFG["smtp_port"], timeout=30) as s:
            s.send_message(msg)
        return
    if CFG["smtp_tls"] == "ssl":
        with smtplib.SMTP_SSL(CFG["smtp_host"], 465, context=ctx, timeout=30) as s:
            s.login(CFG["smtp_user"], CFG["smtp_pass"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(CFG["smtp_host"], CFG["smtp_port"], timeout=30) as s:
            s.starttls(context=ctx)
            s.login(CFG["smtp_user"], CFG["smtp_pass"])
            s.send_message(msg)


def send_and_record(seq, retry_label=""):
    with db() as con:
        r = con.execute("SELECT * FROM registrations WHERE seq=?", (seq,)).fetchone()
    if not r or not r["email"]:
        return
    f = json.loads(r["fields_json"])
    vars_ = dict(f)
    vars_.update({"id": r["reg_id"], "firstName": r["first_name"], "lastName": r["last_name"]})
    try:
        send_mail(r["email"], vars_)
        status = "أُرسل" + retry_label
    except Exception as e:  # noqa: BLE001
        log("mail failed", r["reg_id"], repr(e))
        status = "فشل الإرسال: " + str(e)[:120]
    with DB_LOCK, db() as con:
        con.execute("UPDATE registrations SET email_status=? WHERE seq=?", (status, seq))


def resend_failed():
    with db() as con:
        rows = con.execute(
            "SELECT seq, reg_id FROM registrations WHERE email IS NOT NULL AND email_status NOT LIKE 'أُرسل%'"
        ).fetchall()
    print(f"إعادة إرسال {len(rows)} رسالة")
    for r in rows:
        send_and_record(r["seq"], " (إعادة)")
        time.sleep(1)


# ======================== تصدير Excel ========================

BASE_COLS = [("_id", "رقم التسجيل"), ("_time", "وقت التسجيل")]
TECH_COLS = [("_email", "حالة بريد التأكيد"), ("_phone", "الرقم (موحّد)"), ("_device", "معرّف الجهاز"),
             ("_fp", "بصمة الجهاز"), ("_ua", "المتصفح"), ("_ip", "عنوان IP")]


def export_rows(event=None):
    with db() as con:
        cols = [(r["key"], r["label"]) for r in con.execute("SELECT key,label FROM columns ORDER BY ord")]
        q = "SELECT * FROM registrations" + (" WHERE event=?" if event else "") + " ORDER BY seq"
        regs = con.execute(q, (event,) if event else ()).fetchall()
    header = [l for _, l in BASE_COLS] + [l for _, l in cols] + [l for _, l in TECH_COLS]
    rows = []
    for r in regs:
        f = json.loads(r["fields_json"])
        rows.append(
            [r["reg_id"], r["created_at"]] + [f.get(k, "") for k, _ in cols] +
            [r["email_status"] or "", r["phone"] or "", r["device_id"], r["fingerprint"] or "",
             r["user_agent"] or "", r["ip"] or ""]
        )
    return header, rows


def col_letter(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def build_xlsx(header, rows):
    """ملف xlsx بسيط (بدون مكتبات): ورقة من اليمين لليسار، صف عنوان مثبّت، وتصفية تلقائية."""
    def cell(ref, v, style=0):
        v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(v))
        s = f' s="{style}"' if style else ""
        return f'<c r="{ref}" t="inlineStr"{s}><is><t xml:space="preserve">{xml_escape(v)}</t></is></c>'

    all_rows = [header] + rows
    last = f"{col_letter(len(header) - 1)}{max(len(all_rows), 1)}"
    sheet_rows = []
    for ri, row in enumerate(all_rows, start=1):
        cells = "".join(cell(f"{col_letter(ci)}{ri}", v, 1 if ri == 1 else 0) for ci, v in enumerate(row))
        sheet_rows.append(f'<row r="{ri}">{cells}</row>')
    widths = "".join(f'<col min="{i+1}" max="{i+1}" width="{22 if i < len(header) - 6 else 16}" customWidth="1"/>'
                     for i in range(len(header)))
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView rightToLeft="1" workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<cols>{widths}</cols><sheetData>{"".join(sheet_rows)}</sheetData>'
        f'<autoFilter ref="A1:{last}"/></worksheet>'
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font>'
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF13235B"/></patternFill></fill></fills>'
        '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
        '<cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="التسجيلات" sheetId="1" r:id="rId1"/></sheets>'
        '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'
        f"'التسجيلات'!$A$1:${col_letter(len(header) - 1)}${max(len(all_rows), 1)}</definedName></definedNames>"
        '</workbook>'
    )
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'
        ),
        "xl/workbook.xml": workbook,
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sheet,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


# ======================== HTTP ========================

RATE = {}
RATE_LOCK = threading.Lock()


def rate_ok(ip):
    t = time.time()
    with RATE_LOCK:
        hits = [h for h in RATE.get(ip, []) if t - h < 600]
        if len(hits) >= CFG["rate_limit"]:
            RATE[ip] = hits
            return False
        hits.append(t)
        RATE[ip] = hits
        if len(RATE) > 5000:
            for k in list(RATE)[:1000]:
                RATE.pop(k, None)
        return True


ADMIN_PAGE = """<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>إدارة التسجيلات</title>
<style>body{{font-family:Tahoma,Arial,sans-serif;background:#EEF3FA;color:#13235B;margin:0;padding:24px 16px}}
.box{{max-width:640px;margin:auto;background:#fff;border:1px solid #D5DEEC;border-radius:14px;padding:22px}}
h1{{margin:0 0 4px;font-size:1.3rem}} .n{{font-size:2.4rem;font-weight:700}} .muted{{color:#5A6788;font-size:.9rem}}
a.btn{{display:inline-block;background:#13235B;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;margin-top:12px}}
table{{width:100%;border-collapse:collapse;margin-top:18px;font-size:.9rem}} td,th{{text-align:right;padding:6px;border-bottom:1px solid #eee}}</style>
</head><body><div class="box"><h1>تسجيلات {event}</h1><p class="muted">آخر تحديث: {now}</p>
<div class="n">{count}</div><div class="muted">تسجيل · البريد المرسل: {sent} · لم يُرسل: {failed}</div>
<a class="btn" href="/admin/export.xlsx">تنزيل ملف Excel</a>
<table><tr><th>الفئة</th><th>العدد</th></tr>{groups}</table></div></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "sto-register/1.0"

    def log_message(self, fmt, *args):  # سجل مختصر
        pass

    def client_ip(self):
        if CFG["trust_proxy"]:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()
        return self.client_address[0]

    def cors(self):
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if origin and (origin in CFG["origins"] or "*" in CFG["origins"]):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def admin_ok(self):
        if not CFG["admin_pass"]:
            return False
        h = self.headers.get("Authorization", "")
        if not h.startswith("Basic "):
            return False
        try:
            user, pw = base64.b64decode(h[6:]).decode().split(":", 1)
        except Exception:  # noqa: BLE001
            return False
        return hmac.compare_digest(user, CFG["admin_user"]) and hmac.compare_digest(pw, CFG["admin_pass"])

    def ask_auth(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="registrations", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            return self.send_json(200, {"ok": True, "service": "sto-register"})
        if path.startswith("/admin"):
            if not self.admin_ok():
                return self.ask_auth()
            if path == "/admin/export.xlsx":
                header, rows = export_rows()
                data = build_xlsx(header, rows)
                name = f"registrations-{CFG['event']}-{datetime.now().strftime('%Y%m%d-%H%M')}.xlsx"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(data)
            if path == "/admin":
                with db() as con:
                    count = con.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
                    sent = con.execute("SELECT COUNT(*) FROM registrations WHERE email_status LIKE 'أُرسل%'").fetchone()[0]
                    failed = con.execute("SELECT COUNT(*) FROM registrations WHERE email_status LIKE 'فشل%'").fetchone()[0]
                    groups = {}
                    for r in con.execute("SELECT fields_json FROM registrations"):
                        g = json.loads(r[0]).get("roleGroup") or "—"
                        groups[g] = groups.get(g, 0) + 1
                rows = "".join(f"<tr><td>{html.escape(k)}</td><td>{v}</td></tr>"
                               for k, v in sorted(groups.items(), key=lambda x: -x[1]))
                page = ADMIN_PAGE.format(event=html.escape(CFG["event"]), now=now_iso(), count=count,
                                         sent=sent, failed=failed, groups=rows).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(page)
        self.send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/register":
            return self.send_json(404, {"ok": False, "error": "not_found"})
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if origin and origin not in CFG["origins"] and "*" not in CFG["origins"]:
            return self.send_json(403, {"ok": False, "error": "origin"})
        if not rate_ok(self.client_ip()):
            return self.send_json(429, {"ok": False, "error": "rate"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self.send_json(413, {"ok": False, "error": "size"})
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError
        except Exception:  # noqa: BLE001
            return self.send_json(400, {"ok": False, "error": "invalid"})
        try:
            res = register(data, self.client_ip())
        except sqlite3.IntegrityError:
            res = {"ok": False, "duplicate": True, "reason": "device"}
        except Exception as e:  # noqa: BLE001
            log("error", repr(e))
            return self.send_json(500, {"ok": False, "error": "server"})
        self.send_json(200, res)


def main():
    init_db()
    if len(sys.argv) > 1 and sys.argv[1] == "resend":
        return resend_failed()
    if len(sys.argv) > 2 and sys.argv[1] == "testmail":
        if not EMAIL_RE.match(sys.argv[2]) or not sys.argv[2].isascii():
            return print("اكتب عنوان بريد صحيحاً، مثل: name@example.com")
        send_mail(sys.argv[2], {"id": "TEST-0000", "firstName": "تجربة", "lastName": "", "role": "—"})
        return print("أُرسلت رسالة تجريبية إلى", sys.argv[2])
    if not CFG["admin_pass"]:
        log("تنبيه: ADMIN_PASS غير مضبوط، صفحة الإدارة معطّلة")
    if CFG["mail_enabled"] and not CFG["smtp_pass"]:
        log("تنبيه: SMTP_PASS غير مضبوط، لن يُرسل بريد التأكيد")
    srv = ThreadingHTTPServer((CFG["host"], CFG["port"]), Handler)
    log(f"listening on {CFG['host']}:{CFG['port']} — origins: {CFG['origins']}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
