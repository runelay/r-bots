\set ON_ERROR_STOP on
\if :{?app_user}
\else
  \set app_user runelay_app
\endif
\if :{?app_password}
\else
  \echo 'usage: psql -v app_password="$(cat <data>/secrets/postgres-app.password)" -f switch-to-app-role.sql'
  \quit
\endif

BEGIN;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_user', :'app_password') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'app_user') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', schemaname, tablename, :'app_user')
FROM pg_tables WHERE schemaname = 'public' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', sequence_schema, sequence_name, :'app_user')
FROM information_schema.sequences WHERE sequence_schema = 'public' \gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', schemaname, viewname, :'app_user')
FROM pg_views WHERE schemaname = 'public' \gexec
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', schemaname, matviewname, :'app_user')
FROM pg_matviews WHERE schemaname = 'public' \gexec
SELECT format('ALTER FUNCTION %s OWNER TO %I', p.oid::regprocedure, :'app_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
WHERE n.nspname = 'public' AND d.objid IS NULL \gexec
SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, :'app_user')
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND d.objid IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid) \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
COMMIT;
\echo 'done: set POSTGRES_APP_USER in .env and recreate the server'
