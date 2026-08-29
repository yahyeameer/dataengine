#!/usr/bin/env bash
#
# Run on the VPS, over SSH, before deploying apps/web beside the Hermes Agent.
#
# Everything apps/web/docker-compose.yml needs from the host is discoverable,
# and every one of those values fails in a way that is hard to read if it is
# wrong: a bad Traefik entrypoint creates a router that never matches a request,
# a bad network name means labels Traefik cannot see, a bad gateway address
# means a 502 on every question and nothing in the app's own logs. So find them
# all at once, before the first deploy, rather than one outage at a time.
#
#   ssh root@srv1927440 'bash -s' < scripts/vps-preflight.sh
#
# Read-only. Starts nothing, changes nothing, creates nothing.

set -uo pipefail

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
val() { printf '  %-22s %s\n' "$1" "$2"; }

say "Host"
val "cores (nproc)" "$(nproc)"
val "memory" "$(free -h | awk '/^Mem:/ {print $3 " used of " $2}')"
val "load (1/5/15m)" "$(awk '{print $1, $2, $3}' /proc/loadavg)"
val "cgroup" "$(stat -fc %T /sys/fs/cgroup)"
# Load above the core count on a one-core box is the state that gets the whole
# VPS throttled, so it belongs next to the core count rather than alone.
#
# cgroup2fs means v2. `cat /sys/fs/cgroup/cpu.max` failing at the ROOT is normal
# on v2 and proves nothing -- the root cgroup has no cpu.max by design. Either
# way `deploy.resources.limits.cpus` works; Docker translates it per version.

say "Containers"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

say "CPU and I/O right now"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}'

say "Restart counts"
# A container that keeps dying and restarting re-reads its layers every time,
# which shows up as implausible block I/O and as sustained load with nothing
# obviously running. Cheapest possible test for it.
for c in $(docker ps --format '{{.Names}}'); do
  val "$c" "$(docker inspect "$c" -f '{{.RestartCount}} restarts, up since {{.State.StartedAt}}')"
done

say "Hermes gateway  -> HERMES_NETWORK, HERMES_WEBHOOK_URL"
hermes=$(docker ps --format '{{.Names}}' | grep -i hermes | head -1)
if [ -n "$hermes" ]; then
  val "container" "$hermes"
  val "networks" "$(docker inspect "$hermes" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} (aliases: {{range $v.Aliases}}{{.}} {{end}}){{end}}')"
  val "published" "$(docker port "$hermes" | tr '\n' ' ')"
  hermes_ip=$(docker inspect "$hermes" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
  val "container IP" "$hermes_ip"

  # /proc/net/tcp rather than a tool inside the image: that container has no
  # wget, no curl and no ss, and this file is always present. Ports it listens
  # on but does not publish still matter -- the web app reaches them over the
  # shared network, which is the entire point of this deployment.
  echo "  listening inside (published or not):"
  #
  # `strtonum` is a gawk extension and Ubuntu ships mawk, so the hex stays in
  # awk and the conversion happens in the shell. Filtering on a local address of
  # 00000000 keeps this to real listeners on 0.0.0.0 and drops Docker's own
  # resolver, which binds 127.0.0.11 on a random high port.
  ports=$(docker exec "$hermes" cat /proc/net/tcp 2>/dev/null |
    awk 'NR>1 && $4=="0A" {split($2,a,":"); if (a[1]=="00000000") print a[2]}' |
    while read -r h; do echo $((16#$h)); done |
    sort -un)
  echo "$ports" | sed 's/^/    port /'

  # Which one is the webhook gateway is not knowable from outside, so ask it.
  # A deliberately invalid signature is the probe: 401 or 403 means the endpoint
  # exists and rejected us, which is the answer we want; 404 means wrong port or
  # wrong path. Nothing is created either way -- the HMAC cannot verify, so the
  # agent has nothing to act on.
  # The header scheme this installation documents: HMAC-SHA256 over the raw
  # body as X-Hub-Signature-256. The signature here is deliberately wrong, so a
  # gateway that is there answers 401 or 403 -- the positive result. A 404 means
  # the route is not on that port. 4860 is the dashboard; it should answer neither.
  echo "  probing /webhooks/ask (401/403 = gateway found, 404 = not this port):"
  for port in $ports; do
    code=$(curl -sS -o /dev/null -m 5 -w '%{http_code}' \
      -X POST "http://${hermes_ip}:${port}/webhooks/ask" \
      -H 'Content-Type: application/json' \
      -H 'X-GitHub-Event: job.dispatched' \
      -H 'X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
      -d '{"request_id":"00000000-0000-0000-0000-000000000000","workspace_id":"00000000-0000-0000-0000-000000000000","question":"preflight"}' \
      2>/dev/null || echo "no answer")
    val "  port $port" "HTTP $code"
  done
else
  val "container" "NOT FOUND -- is the agent application running?"
fi

say "Traefik  -> TRAEFIK_NETWORK, TRAEFIK_ENTRYPOINT, TRAEFIK_CERTRESOLVER"
traefik=$(docker ps --format '{{.Names}}' | grep -i traefik | head -1)
if [ -n "$traefik" ]; then
  val "networks" "$(docker inspect "$traefik" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  # Empty here means Traefik is running but not serving the internet, which is
  # the one case where the bundled Caddy fallback is the right answer.
  published=$(docker port "$traefik" | tr '\n' ' ')
  val "published" "${published:-NONE -- not serving the internet}"

  # Config.Cmd is null whenever an image sets ENTRYPOINT instead (the agent
  # image on srv1927440 is one such), so read all three, plus the environment,
  # since Traefik accepts every flag as a TRAEFIK_* variable too.
  echo "  entrypoint / certresolver names:"
  {
    docker inspect "$traefik" -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .Args}}'
    docker inspect "$traefik" -f '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}'
  } | tr ',' '\n' | grep -Ei 'entrypoint|certificatesresolver|acme' | sed 's/^/    /' ||
    echo "    (nothing in argv or env -- read the static config instead:
     docker exec $traefik sh -c 'cat /etc/traefik/traefik.y*ml')"
else
  val "container" "NOT FOUND"
fi

say "Firewall"
# The agent publishes 8642 on 0.0.0.0. If nothing blocks it, that gateway is on
# the public internet with only the HMAC in front of it, and nothing off-box
# needs it once the web app reaches it over the shared Docker network.
ufw status 2>/dev/null || val "ufw" "not installed"

say "Bound on all interfaces"
ss -ltnp 2>/dev/null | awk 'NR==1 || $4 ~ /0\.0\.0\.0|\[::\]/'

printf '\n\033[1mFor apps/web/.env:\033[0m\n'
[ -n "$hermes" ] && echo "  HERMES_NETWORK=$(docker inspect "$hermes" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
[ -n "$traefik" ] && echo "  TRAEFIK_NETWORK=$(docker inspect "$traefik" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
echo "  HERMES_WEBHOOK_URL=http://<service alias>:<the port that answered 401/403>"
echo "  TRAEFIK_ENTRYPOINT / TRAEFIK_CERTRESOLVER from the Traefik block above"
