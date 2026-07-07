#!/bin/sh
# Ежедневный pg_dump (NFR-03: RPO ≤ 24 ч). Первый прогон — сразу при старте, далее раз в сутки.
# Ретеншн — BACKUP_RETENTION_DAYS (по умолчанию 14): старые дампы удаляются перед выходом.
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump_file="$BACKUP_DIR/onsite-$timestamp.sql.gz"

  echo "backup-postgres: старт дампа -> $dump_file"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
      -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      | gzip > "$dump_file"; then
    echo "backup-postgres: дамп готов ($(du -h "$dump_file" | cut -f1))"
  else
    echo "backup-postgres: ОШИБКА дампа" >&2
    rm -f "$dump_file"
  fi

  find "$BACKUP_DIR" -name 'onsite-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
  echo "backup-postgres: следующий прогон через 24ч"
  sleep 86400
done
