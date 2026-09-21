#!/bin/bash
# Разовый запуск платформы локально "в одну команду" — для разработки/просмотра,
# не для продакшена.
#
#   git clone -b claude/add-marketing-skills-wyxcp5 https://github.com/Fraidyles/Volna-LMS.git
#   cd Volna-LMS && bash scripts/dev-setup.sh
#
# Что делает:
#   1. Создаёт .env с готовыми (сгенерированными/дефолтными) значениями, если его ещё нет.
#   2. Если есть Docker — поднимает Postgres в контейнере lms-postgres с теми же
#      кредами, что и в .env. Если Docker не найден — использует то, что уже
#      указано в DATABASE_URL (считая, что Postgres у вас уже настроен сами).
#   3. Ставит зависимости, накатывает схему, сеет демо-курс и первого администратора.
#   4. Запускает сервер на http://localhost:8790.
#
# Повторный запуск безопасен: .env не перезаписывается, если уже существует,
# миграция и сид идемпотентны (IF NOT EXISTS / ON CONFLICT).

set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_EMAIL="admin@dev.local"
ADMIN_PASSWORD="DevAdminPass123!"

if [ ! -f .env ]; then
  echo "Создаю .env…"
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  cat > .env <<EOF
PORT=8790
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:8790
DATABASE_URL=postgres://lms_user:lms_dev_pw@localhost:5432/lms
PGSSL=false
JWT_SECRET=$JWT_SECRET
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASSWORD
BOOTSTRAP_ADMIN_NAME=Главный администратор
EOF
else
  echo ".env уже существует — оставляю как есть."
  # Не export $(... | xargs) всей пачкой — ломается на значениях с пробелами
  # (например, BOOTSTRAP_ADMIN_NAME). Достаточно вытащить только то, что нужно
  # для приветственного сообщения ниже; сам .env целиком читает dotenv в Node.
  EXISTING_EMAIL=$(grep '^BOOTSTRAP_ADMIN_EMAIL=' .env | head -1 | cut -d'=' -f2-)
  EXISTING_PASSWORD=$(grep '^BOOTSTRAP_ADMIN_PASSWORD=' .env | head -1 | cut -d'=' -f2-)
  [ -n "$EXISTING_EMAIL" ] && ADMIN_EMAIL="$EXISTING_EMAIL"
  [ -n "$EXISTING_PASSWORD" ] && ADMIN_PASSWORD="$EXISTING_PASSWORD"
fi

DOCKER_PG_STARTED=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' | grep -q '^lms-postgres$'; then
    docker start lms-postgres >/dev/null 2>&1 && DOCKER_PG_STARTED=true
  else
    echo "Поднимаю Postgres в Docker (контейнер lms-postgres)…"
    if docker run -d --name lms-postgres -p 5432:5432 \
      -e POSTGRES_USER=lms_user -e POSTGRES_PASSWORD=lms_dev_pw -e POSTGRES_DB=lms \
      postgres:16 >/dev/null; then
      DOCKER_PG_STARTED=true
    else
      echo "Не удалось поднять контейнер (может, порт 5432 уже занят) — проверьте DATABASE_URL в .env вручную."
    fi
  fi
else
  echo "Docker недоступен (не установлен или демон не запущен) — использую Postgres, указанный в DATABASE_URL из .env. Убедитесь, что он запущен."
fi

if [ "$DOCKER_PG_STARTED" = true ]; then
  echo "Жду готовности Postgres…"
  for i in $(seq 1 20); do
    docker exec lms-postgres pg_isready -U lms_user >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "Устанавливаю зависимости…"
npm install

echo "Накатываю схему БД…"
npm run migrate

echo "Засеиваю демо-курс и первого администратора…"
npm run seed

echo ""
echo "Готово. Открывайте http://localhost:8790"
echo "Вход: $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo ""
npm start
