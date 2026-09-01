#!/usr/bin/env bash
#
# Can the deploy actually happen? Answers that without doing it.
#
# Run from GitHub Actions by the "Deploy preflight" workflow, or by hand:
#
#   ssh root@100.90.45.107 "bash -s -- /opt/dataengine" < scripts/deploy-preflight.sh
#
# Every one of these is a thing that has already failed a deploy, or is the next
# candidate to. Checking them costs seconds and reading the answer is faster
# than reading a failed deploy's logs.
#
# Read-only. Pulls nothing, starts nothing, changes nothing.

set -uo pipefail

app_dir="${1:-/opt/dataengine}"
web_file="${2:-docker-compose.demo.yml}"
web_project="${3:-dataengine}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
val() { printf '  %-24s %s\n' "$1" "$2"; }

say "Who and where"
val "hostname" "$(hostname)"
val "user" "$(whoami)"
val "tailscale" "$(tailscale ip -4 2>/dev/null || echo 'not on the tailnet')"

say "The checkout the deploy resets"
if [ -d "$app_dir/.git" ]; then
  val "path" "$app_dir"
  val "remote" "$(git -C "$app_dir" remote get-url origin 2>/dev/null || echo none)"
  val "branch" "$(git -C "$app_dir" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  val "head" "$(git -C "$app_dir" log -1 --format='%h %s' 2>/dev/null)"
  # The deploy fetches and resets to a SHA. A checkout that cannot fetch is the
  # failure this catches -- and it is read-only, unlike the reset itself.
  if git -C "$app_dir" fetch --dry-run --quiet origin 2>/dev/null; then
    val "can fetch" "yes"
  else
    val "can fetch" "NO -- the deploy key cannot reach origin"
  fi
else
  val "path" "$app_dir -- MISSING, or not a git checkout"
fi

say "The .env files compose reads"
for f in "$app_dir/apps/web/.env" "$app_dir/services/hermes/.env"; do
  if [ -f "$f" ]; then
    val "$(basename "$(dirname "$f")")/.env" "present, $(wc -l < "$f") lines"
  else
    val "$(basename "$(dirname "$f")")/.env" "MISSING -- compose will refuse to start"
  fi
done

say "What is running now"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null || echo "  docker not reachable"

say "The stack the deploy targets"
# Getting this wrong does not error -- compose builds a second stack and leaves
# the running one alone -- so it is worth seeing named before a deploy, not
# after one that went green while the site served the old build.
val "web compose file" "$web_file"
val "web project" "$web_project"
if [ -f "$app_dir/apps/web/$web_file" ]; then
  cid=$(cd "$app_dir/apps/web" && docker compose -p "$web_project" -f "$web_file" ps -q web 2>/dev/null)
  if [ -n "$cid" ]; then
    val "running web container" "$(docker inspect -f '{{.Name}} <- {{.Config.Image}}' "$cid" 2>/dev/null)"
  else
    val "running web container" "none found under that project name"
  fi
else
  val "web compose file" "MISSING at $app_dir/apps/web/$web_file"
fi

say "Can this box pull the images?"
# The open question after reachability: packages published by a workflow start
# private, and a private package is a pull that fails with 'denied' on a box
# that has never run `docker login ghcr.io`.
for image in dataengine-web dataengine-hermes; do
  if docker manifest inspect "ghcr.io/yahyeameer/$image:latest" >/dev/null 2>&1; then
    val "$image" "pullable"
  else
    val "$image" "NOT pullable -- package private, or no ghcr login on this box"
  fi
done

say "Room to put them"
df -h / | awk 'NR==2 {print "  " $4 " free of " $2}'
