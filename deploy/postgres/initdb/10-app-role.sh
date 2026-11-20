#!/bin/sh
set -eu

app_user="${POSTGRES_APP_USER:-runelay_app}"
password_file="${POSTGRES_APP_PASSWORD_FILE:-/secrets/postgres-app.password}"
[ -s "$password_file" ] || { echo "app role: $password_file missing, skipped" >&2; exit 0; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$app_user" -v app_password="$(cat "$password_file")" -v db="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'app_user') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
echo "app role: $app_user ready"
