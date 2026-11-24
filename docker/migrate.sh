#!/bin/sh
# Áp dụng migration SQL theo thứ tự tên file, mỗi file đúng một lần.
# Đã áp dụng file nào thì ghi vào bảng schema_migrations, chạy lại sẽ bỏ qua.
#   DATABASE_URL=postgres://... migrate /migrations
set -eu

DIR="${1:-/migrations}"
: "${DATABASE_URL:?Cần DATABASE_URL}"

# Node pg hiểu sslmode=no-verify, psql thì không: đổi sang require (vẫn mã hóa, không kiểm CA).
URL=$(printf '%s' "$DATABASE_URL" | sed 's/sslmode=no-verify/sslmode=require/')

psql_q() { psql "$URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

echo "Chờ Postgres sẵn sàng..."
i=0
until psql_q -c 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "Không kết nối được Postgres sau 120 giây" >&2; exit 1; }
  sleep 2
done

psql_q -c 'CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)'

applied=0
for file in $(ls "$DIR"/*.sql | sort); do
  version=$(basename "$file")
  done_already=$(psql_q -c "SELECT 1 FROM schema_migrations WHERE version = '$version'")
  if [ "$done_already" = "1" ]; then
    echo "  bỏ qua  $version"
    continue
  fi
  echo "  áp dụng $version"
  # File tự có BEGIN/COMMIT của A, nên không bọc thêm transaction.
  psql_q -f "$file"
  psql_q -c "INSERT INTO schema_migrations (version) VALUES ('$version')"
  applied=$((applied + 1))
done

echo "Xong: áp dụng $applied migration mới."
