#!/bin/sh
# Runs once, when the database volume is first created (postgres image init hook).
# The website connects as ghanawatch_app, which can read and write rows but cannot
# create, alter or drop tables, read other databases, or create roles. Migrations and
# the data pipeline keep using the owner account (ghanawatch).
set -eu
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env.production}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<-'SQL'
	CREATE ROLE ghanawatch_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
	REVOKE ALL ON DATABASE ghanawatch FROM PUBLIC;
	GRANT CONNECT ON DATABASE ghanawatch TO ghanawatch_app;
	REVOKE CREATE ON SCHEMA public FROM PUBLIC;
	GRANT USAGE ON SCHEMA public TO ghanawatch_app;
	-- Tables are created later by migrations run as the owner; grant row access to each as it appears.
	ALTER DEFAULT PRIVILEGES FOR ROLE ghanawatch IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ghanawatch_app;
	ALTER DEFAULT PRIVILEGES FOR ROLE ghanawatch IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ghanawatch_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ghanawatch_app;
	GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ghanawatch_app;
SQL
