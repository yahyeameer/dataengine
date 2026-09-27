#!/usr/bin/env bash
#
# Bring up a throwaway PostgreSQL with every migration applied, for `run.py`.
#
# This exists because the end-to-end suites that came before it need Docker, and
# the agent -- the part of this product with the customer's money in it -- had no
# end-to-end coverage that could run on a box without a Docker daemon. All this
# needs is the `postgresql-16` package.
#
#   scripts/e2e/bootstrap.sh          # start it and apply the migrations
#   scripts/e2e/bootstrap.sh --reset  # reapply from an empty database
#   scripts/e2e/bootstrap.sh --stop
#
# The cluster is disposable and listens on a unix socket in /tmp on a
# non-default port, so it cannot collide with a real Postgres on the machine.
# fsync is off for the same reason: it is rebuilt from migrations every run, so
# durability buys nothing and costs seconds. wal_level is logical only so that
# creating Realtime's publication is silent.
set -euo pipefail

PORT="${E2E_PGPORT:-55440}"
PGDATA="${E2E_PGDATA:-/var/lib/postgresql/dataengine-e2e}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

for candidate in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
  [ -x "$candidate/initdb" ] && export PATH="$candidate:$PATH" && break
done

command -v initdb >/dev/null 2>&1 || {
  echo "PostgreSQL server binaries not found. Install postgresql-16 (or later)." >&2
  exit 1
}

running() { pg_isready -h /tmp -p "$PORT" >/dev/null 2>&1; }

# `pg_ctl` refuses to run as root, so every invocation of it goes through the
# postgres account -- including stop. Running it directly appeared to work and
# silently did nothing, which left a cluster up with the previous run's settings.
pg() { su postgres -c "PATH=$PATH pg_ctl $*"; }

case "${1:-}" in
  --stop)
    pg "-D $PGDATA stop" >/dev/null 2>&1 && echo "stopped" || echo "was not running"
    exit 0
    ;;
esac

if ! running; then
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    # `initdb` refuses to run as root, so the cluster belongs to postgres.
    id postgres >/dev/null 2>&1 || useradd --system postgres
    mkdir -p "$PGDATA"
    chown postgres "$PGDATA"
    su postgres -c "PATH=$PATH initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
  fi
  pg "-D $PGDATA -o '-p $PORT -k /tmp -c wal_level=logical -c fsync=off -c synchronous_commit=off' -l ${PGDATA%/*}/dataengine-e2e.log start" >/dev/null
  for _ in $(seq 1 20); do running && break; sleep 0.5; done
  running || { echo "postgres did not start; see ${PGDATA%/*}/dataengine-e2e.log" >&2; exit 1; }
fi

psql -h /tmp -p "$PORT" -U postgres -q \
  -c "drop database if exists dataengine;" -c "create database dataengine;" >/dev/null

psql -h /tmp -p "$PORT" -U postgres -d dataengine -q -v ON_ERROR_STOP=1 \
  -f "$HERE/supabase_stub.sql" >/dev/null

applied=0
for migration in "$ROOT"/supabase/migrations/*.sql; do
  if ! output=$(psql -h /tmp -p "$PORT" -U postgres -d dataengine -q -v ON_ERROR_STOP=1 \
        -f "$migration" 2>&1); then
    echo "migration failed: $(basename "$migration")" >&2
    echo "$output" | grep -v 'NOTICE' | head -20 >&2
    exit 1
  fi
  applied=$((applied + 1))
done

echo "postgres on /tmp:$PORT with $applied migrations applied"
