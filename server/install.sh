#!/usr/bin/env bash
# تثبيت خادم التسجيل على خادم Ubuntu عليه nginx و docker
# الاستخدام:
#   curl -fsSL https://raw.githubusercontent.com/SyrianTechnocrats/oboor2026-register/main/server/install.sh | bash -s -- register-api.syrian-technocrats.org
set -euo pipefail

DOMAIN="${1:-register-api.syrian-technocrats.org}"
REPO="https://github.com/SyrianTechnocrats/oboor2026-register.git"
DIR="/opt/oboor2026-register"
PORT=8787
CERT_EMAIL="info@syrian-technocrats.org"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

say "1/6 تنزيل الكود إلى $DIR"
if [ -d "$DIR/.git" ]; then
  sudo git -C "$DIR" pull --ff-only
else
  sudo git clone "$REPO" "$DIR"
fi
sudo chown -R "$USER":"$USER" "$DIR"
cd "$DIR/server"
mkdir -p data
ok "تم"

say "2/6 ملف الإعدادات .env"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  printf '  كلمة سر بريد info@syrian-technocrats.org (لن تظهر أثناء الكتابة): '
  read -rs SMTP_PASS </dev/tty; echo
  printf '  اختر كلمة سر لصفحة الإدارة /admin (لن تظهر أثناء الكتابة): '
  read -rs ADMIN_PASS </dev/tty; echo
  python3 - "$SMTP_PASS" "$ADMIN_PASS" <<'PY'
import sys, re
smtp, admin = sys.argv[1], sys.argv[2]
s = open('.env', encoding='utf-8').read()
s = re.sub(r'(?m)^SMTP_PASS=.*$', lambda m: 'SMTP_PASS=' + smtp, s)
s = re.sub(r'(?m)^ADMIN_PASS=.*$', lambda m: 'ADMIN_PASS=' + admin, s)
open('.env', 'w', encoding='utf-8').write(s)
PY
  unset SMTP_PASS ADMIN_PASS
  ok "أُنشئ .env (اسم مستخدم الإدارة: admin)"
else
  ok ".env موجود مسبقاً، لم يُغيَّر"
fi

say "3/6 تشغيل التطبيق (docker)"
sudo docker compose -f docker-compose.nginx.yml up -d --build
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi; sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" && echo && ok "التطبيق يعمل على 127.0.0.1:$PORT" || { warn "التطبيق لم يستجب"; sudo docker compose -f docker-compose.nginx.yml logs --tail 40; exit 1; }

say "4/6 إعداد nginx للنطاق $DOMAIN"
SITE="/etc/nginx/sites-available/$DOMAIN"
if [ ! -f "$SITE" ]; then
  sudo tee "$SITE" >/dev/null <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
NGX
  sudo ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
fi
sudo nginx -t && sudo systemctl reload nginx && ok "nginx جاهز"

say "5/6 شهادة HTTPS"
MYIP="$(curl -s -4 ifconfig.me || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ "$DNSIP" != "$MYIP" ]; then
  warn "النطاق $DOMAIN يشير إلى '${DNSIP:-لا شيء}' وليس إلى هذا الخادم ($MYIP)."
  warn "أضف سجل A للنطاق الفرعي بقيمة $MYIP، ثم أعد تشغيل نفس الأمر."
  exit 0
fi
if ! command -v certbot >/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq certbot python3-certbot-nginx
fi
if sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  ok "الشهادة موجودة مسبقاً"
else
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERT_EMAIL" --redirect
fi
curl -fsS "https://$DOMAIN/health" && echo && ok "يعمل على https://$DOMAIN"

say "6/6 تجربة البريد"
printf '  اكتب بريداً لاستقبال رسالة تجريبية (أو اضغط Enter للتخطي): '
read -r TEST_TO </dev/tty || TEST_TO=""
if [ -n "$TEST_TO" ]; then
  sudo docker compose -f docker-compose.nginx.yml exec -T app python3 server.py testmail "$TEST_TO" \
    && ok "أُرسلت. تفقّد الصندوق ومجلد البريد المزعج" \
    || warn "فشل الإرسال — أرسل نص الخطأ أعلاه"
fi

echo
ok "صفحة الإدارة: https://$DOMAIN/admin  (المستخدم: admin)"
