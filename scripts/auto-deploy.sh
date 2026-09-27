#!/bin/bash
# Автодеплой: раз в несколько минут проверяет origin на новые коммиты текущей
# ветки, при наличии — подтягивает, ставит зависимости (если package.json
# менялся) и перезапускает pm2. Миграция схемы БД отдельно не нужна — она
# применяется сама при каждом старте сервера (см. src/server.js).
#
# Настройка (один раз, на сервере):
#   chmod +x scripts/auto-deploy.sh
#   crontab -e
#   Добавить строку (проверка каждые 3 минуты):
#   */3 * * * * cd /путь/к/Volna-LMS && ./scripts/auto-deploy.sh >> /var/log/lms-autodeploy.log 2>&1
#
# Имя pm2-процесса — второй аргумент (по умолчанию lms-backend):
#   ./scripts/auto-deploy.sh lms-backend
#
# Ничего не открывает наружу и не требует секретов в GitHub — просто
# периодически спрашивает у GitHub "есть что-то новое?" через git fetch.

set -euo pipefail
cd "$(dirname "$0")/.."

PM2_NAME="${1:-lms-backend}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCK="/tmp/lms-autodeploy.lock"

# Не запускаться поверх себя же, если предыдущий прогон почему-то ещё не завершился
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date)] Предыдущий деплой ещё выполняется — пропускаю."
  exit 0
fi

git fetch origin "$BRANCH" --quiet

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date)] Найдены новые коммиты в $BRANCH: $LOCAL -> $REMOTE"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[$(date)] СТОП: в рабочей копии есть незакоммиченные изменения — руками разберитесь, автодеплой пропущен."
  exit 1
fi

PKG_CHANGED=""
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package.json package-lock.json; then
  PKG_CHANGED=1
fi

git merge --ff-only "origin/$BRANCH"
echo "[$(date)] Обновлено до $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

if [ -n "$PKG_CHANGED" ]; then
  echo "[$(date)] package.json менялся — ставлю зависимости"
  npm install --production
fi

pm2 restart "$PM2_NAME"
echo "[$(date)] pm2 restart $PM2_NAME — готово"
