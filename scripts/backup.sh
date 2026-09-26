#!/bin/bash
# Бэкап базы данных LMS через pg_dump + автоочистка старых копий.
#
# Настройка (один раз):
#   chmod +x scripts/backup.sh
#   crontab -e
#   Добавить строку (бэкап каждую ночь в 03:00):
#   0 3 * * * cd /путь/к/lms-backend && ./scripts/backup.sh >> /var/log/lms-backup.log 2>&1
#
# Восстановление из бэкапа:
#   gunzip -c backups/lms_2026-01-15_030000.sql.gz | psql "$DATABASE_URL"

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # Ни export $(... | xargs) (падает на значении с пробелом, например
  # BOOTSTRAP_ADMIN_NAME=Главный администратор), ни прямой `source .env`
  # (тот же пробел без кавычек — уже невалидный bash) не годятся. Парсим
  # тем же пакетом dotenv, что и src/server.js, — одна точка правды для
  # формата .env, — и оборачиваем каждое значение в безопасные для shell
  # одинарные кавычки перед export.
  eval "$(node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    const env = dotenv.parse(fs.readFileSync(".env"));
    for (const [k, v] of Object.entries(env)) {
      const q = "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
      process.stdout.write("export " + k + "=" + q + "\n");
    }
  ')"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL не задан (проверьте .env)"; exit 1
fi

BACKUP_DIR="backups"
RETENTION_DAYS=14
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
FILE="$BACKUP_DIR/lms_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Делаю бэкап базы в $FILE"
pg_dump "$DATABASE_URL" | gzip > "$FILE"
echo "[$(date)] Готово: $(du -h "$FILE" | cut -f1)"

echo "[$(date)] Удаляю бэкапы старше $RETENTION_DAYS дней"
find "$BACKUP_DIR" -name "lms_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete

echo "[$(date)] Бэкап завершён"
