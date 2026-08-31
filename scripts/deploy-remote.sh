#!/usr/bin/env bash
#
# Move the VPS onto one commit. Run by .github/workflows/ci.yml over SSH:
#
#   ssh root@srv1927440 "bash -s -- <sha> <app-dir>" < scripts/deploy-remote.sh
#
# It is a file rather than a heredoc inside the workflow so that it can be read,
# diffed and run by hand -- which is what you will want at 2am, and which a
# script embedded in YAML makes needlessly hard:
#
#   ssh root@srv1927440 "bash -s -- $(git rev-parse HEAD) /root/dataengine" \
#     < scripts/deploy-remote.sh
#
# What it does NOT do is build. The web image takes several minutes of every
# core to build and this box has one; that is the whole reason the images are
# built in Actions and only pulled here. See the note on `cpus` in
# apps/web/docker-compose.yml.

set -euo pipefail

sha="${1:?usage: deploy-remote.sh <commit-sha> <app-dir> [web-compose-file] [web-project]}"
app_dir="${2:?usage: deploy-remote.sh <commit-sha> <app-dir> [web-compose-file] [web-project]}"

# Which web stack this box runs, and it is not the obvious one. The VPS serves
# docker-compose.demo.yml under the project name `dataengine` -- the app behind
# an SSH tunnel rather than behind Traefik, because the demo file needs no
# domain or DNS record. Getting either of these wrong does not fail: compose
# happily creates a SECOND stack from the other file, leaves the running one
# untouched, and the deploy goes green while the site serves the old build.
#
# Both are repository variables (VPS_WEB_COMPOSE_FILE, VPS_WEB_PROJECT), so the
# switch to docker-compose.yml when a domain exists is a settings change rather
# than an edit here.
web_file="${3:-docker-compose.demo.yml}"
web_project="${4:-dataengine}"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "Sync the checkout to $sha"
cd "$app_dir"
git fetch --prune --quiet origin
# The compose files, the .env layout and the image all move together. Deploying
# an image without the compose file that matches it is how a service comes up
# missing an environment variable that was added in the same change.
#
# `reset --hard` and not `pull`: this checkout is a deployment artefact, not
# somewhere anyone edits, and a merge conflict here would be a stuck deploy with
# no one watching. Untracked files are left alone, which is what keeps the .env
# files beside each compose file -- they are gitignored and must survive this.
git reset --hard --quiet "$sha"
git --no-pager log -1 --format='  %h  %s'

# Overrides WEB_TAG/HERMES_TAG from the .env files: compose prefers the
# environment over the file. This is what pins the deploy to the image this run
# just built, rather than to whatever `latest` happens to mean by the time the
# pull below actually runs.
export WEB_TAG="$sha" HERMES_TAG="$sha"

# Named services, not a bare `docker compose pull`. The worker's compose file
# also defines kanban-socket-proxy, which is built from a local Dockerfile and
# has no registry image to fetch -- a bare pull fails on it.
step "web  ($web_file, project $web_project)"
cd "$app_dir/apps/web"
docker compose -p "$web_project" -f "$web_file" pull web
docker compose -p "$web_project" -f "$web_file" up -d web

step "hermes"
cd "$app_dir/services/hermes"
docker compose pull hermes
docker compose up -d hermes

step "Reclaim disk"
# Every deploy leaves a tagged image behind and nothing collects it. A 1 GB VPS
# fills quietly and then all at once. Images backing a running container are
# never eligible, so this cannot take the app down -- and a week of history is
# kept deliberately, because the rollback path is `WEB_TAG=<old-sha> up -d` and
# that only works while the old image is still on the box.
docker image prune -af --filter "until=168h" >/dev/null || true
df -h / | awk 'NR==2 {print "  " $4 " free of " $2}'
