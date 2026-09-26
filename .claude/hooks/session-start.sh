#!/bin/bash
set -euo pipefail

# Этот контейнер — эфемерная песочница без systemd как PID 1: postgresql не
# автостартует сам, а при пересоздании контейнера (например, после простоя
# сессии) все запущенные процессы гибнут не мягко (postgres потом пишет в лог
# "database system was interrupted" / "was not properly shut down"). Данные на
# диске переживают пересоздание, сами процессы — нет. Поднимаем postgres здесь,
# чтобы к началу работы он был готов, а не падал посреди первой же команды.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

service postgresql start >/dev/null 2>&1 || true

for i in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "postgresql: ready"
    exit 0
  fi
  sleep 1
done

echo "postgresql: not ready after 30s (continuing anyway)" >&2
exit 0
