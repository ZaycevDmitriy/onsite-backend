#!/bin/sh
# Ежедневное зеркалирование бакета фотоотчётов (NFR-03: RPO ≤ 24 ч).
# Ретеншн снапшотов — BACKUP_RETENTION_DAYS (по умолчанию 14).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot_dir="$BACKUP_DIR/minio-$timestamp"

  echo "backup-minio: старт зеркалирования -> $snapshot_dir"
  if mc mirror --quiet "local/$S3_BUCKET" "$snapshot_dir"; then
    echo "backup-minio: снапшот готов"
  else
    echo "backup-minio: ОШИБКА зеркалирования" >&2
    rm -rf "$snapshot_dir"
  fi

  find "$BACKUP_DIR" -maxdepth 1 -name 'minio-*' -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} +
  echo "backup-minio: следующий прогон через 24ч"
  sleep 86400
done
