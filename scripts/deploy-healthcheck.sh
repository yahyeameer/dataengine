#!/usr/bin/env bash
#
# Did the thing we just deployed actually come up? Run by
# .github/workflows/ci.yml over SSH, immediately after scripts/deploy-remote.sh:
#
#   ssh root@srv1927440 "bash -s -- <app-dir>" < scripts/deploy-healthcheck.sh
#
# Why this exists as a separate step: `docker compose up -d` returns 0 as soon
# as the container is *started*, which it also does for a container that is
# about to crash-loop on a missing environment variable. Without this, a deploy
# that took the site down would report a green tick.
#
# Exit 0 means the new web container is serving and the worker is running.

set -uo pipefail

app_dir="${1:?usage: deploy-healthcheck.sh <app-dir> [web-compose-file] [web-project]}"
# Must match scripts/deploy-remote.sh, or this checks the health of a stack the
# deploy did not touch -- which passes, every time, for the wrong reason.
web_file="${2:-docker-compose.demo.yml}"
web_project="${3:-dataengine}"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "web  ($web_file, project $web_project)"
cd "$app_dir/apps/web"
cid="$(docker compose -p "$web_project" -f "$web_file" ps -q web)"
if [ -z "$cid" ]; then
  echo "  no web container -- 'up -d' did not leave one running"
  exit 1
fi

# The image declares a HEALTHCHECK (a real fetch of /), so this reads a verdict
# the container reached itself rather than inventing a second definition of
# healthy here. 40 x 5s covers the image's own 20s start period plus a cold
# Next boot on a throttled single core, with room to spare.
status=starting
for _ in $(seq 1 40); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo gone)"
  case "$status" in
    healthy)
      echo "  healthy"
      break
      ;;
    unhealthy|gone)
      echo "  $status"
      docker logs --tail 50 "$cid"
      exit 1
      ;;
  esac
  sleep 5
done

if [ "$status" != healthy ]; then
  echo "  still '$status' after 200s"
  docker logs --tail 50 "$cid"
  exit 1
fi

step "hermes"
cd "$app_dir/services/hermes"
wid="$(docker compose ps -q hermes)"
if [ -z "$wid" ]; then
  echo "  no hermes container"
  exit 1
fi

# The worker has no listening socket, so there is no request to make. Its
# HEALTHCHECK only proves the process can import its stack and read its config,
# which is the honest limit of what can be checked from outside -- the real
# signal is the heartbeat row it writes, and that belongs to the app, not to a
# deploy gate. Restarting is the failure worth catching here.
state="$(docker inspect -f '{{.State.Status}}' "$wid")"
restarts="$(docker inspect -f '{{.RestartCount}}' "$wid")"
echo "  $state, $restarts restarts"
if [ "$state" != running ]; then
  docker logs --tail 50 "$wid"
  exit 1
fi
