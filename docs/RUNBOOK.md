# Operations runbook

For whoever is on the end of a problem at an hour they did not choose. Every
command here is copy-pasteable and every one has been run against the live box.

Host: `srv1927440`. Access is **key-only** — password authentication is
disabled. If you cannot get in, that is the first thing to check, not the last.

```bash
ssh -i ~/.ssh/srv1927440 root@191.215.42.242
```

---

## "The explanations look worse than they used to"

This is the failure this system is most likely to have, and it does not raise
an error. Every model call degrades to the rule engine on a timeout, an
unreachable endpoint, malformed JSON or a missing key. The job still succeeds,
proposals still appear, and the only symptom is plainer prose.

**Check it in one query:**

```sql
select * from agent_llm_health;
```

`degraded > 0` means jobs succeeded on the fallback and nobody was told.
`first_degraded_at` tells you when it started, which is usually enough to
identify what changed.

**Then work down this list, in order — the top one is by far the most common:**

1. **The worker lost the agent's network.** If the Hermes stack was brought
   `down` and `up`, the external network is recreated with a new id and the
   worker keeps a stale attachment. Nothing errors.

   ```bash
   docker inspect hermes-hermes-1 -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'
   # must print hermes-agent-bwlq_default
   docker exec hermes-hermes-1 python -c "import httpx;print(httpx.get('http://172.16.0.2:8642/health',timeout=5).status_code)"
   ```

   Fix: `cd /opt/dataengine/services/hermes && docker compose up -d`. The
   network is declared in the compose file, so recreating the container
   reattaches it. **Do not** use `docker network connect` — that fixes it until
   the next reboot and hides the problem.

2. **The API server config was lost.** The Hermes agent runs a vendor image on
   a floating `:latest` tag. A vendor pull reverts `/opt/data/.env`.

   ```bash
   docker exec hermes-agent-bwlq-hermes-agent-1 sh -c 'grep -c API_SERVER_ENABLED /opt/data/.env'
   ```

   Expect `1`. If it is `0`, see *Restoring the Hermes configuration* below.

3. **The supervisor profile was reset.** Same cause.

   ```bash
   docker exec hermes-agent-bwlq-hermes-agent-1 \
     sh -c 'ls /opt/data/profiles/ && grep -c mcp_servers /opt/data/profiles/dataengine-supervisor/config.yaml'
   ```

   Expect the three `dataengine-*` profiles and `0` for `mcp_servers`.

---

## "What happened to job X?"

One row, everything an operator needs:

```sql
select * from agent_job_telemetry where job_id = '<uuid>';
```

Workspace, dataset, worker, attempts, timings, model, whether it fell back, and
the error. No customer figures are exposed — names and counts only.

**Recently failed jobs:**

```sql
select job_id, kind, workspace_name, attempts, error, finished_at
from agent_job_telemetry
where status = 'failed' and finished_at > now() - interval '24 hours'
order by finished_at desc;
```

---

## "A job is stuck"

It probably is not. A job `running` with a lapsed lease is **already
recoverable** — `claim_agent_job` treats `status='running' AND lease_expires_at
< now()` as claimable, so the next worker to poll takes it with `attempts`
incremented. Wait one poll interval before doing anything.

```sql
select job_id, kind, status, worker_id, attempts, max_attempts, lease_expires_at
from agent_job_telemetry
where status = 'running' and lease_expires_at < now();
```

Do **not** reset these rows by hand. Do not write a lease reaper — the queue
already is one.

**Is a worker actually alive?** Use the heartbeat, never `claimed_at`. An idle
worker polls every 3 seconds and never updates `claimed_at`, so a stale claim
timestamp on an empty queue means nothing.

```sql
select id, last_seen_at, now() - last_seen_at as age, jobs_claimed
from agent_workers order by last_seen_at desc;
```

Healthy is an age under about 60 seconds — the worker heartbeats every 30.

---

## Restoring the Hermes configuration

The agent runs `ghcr.io/hostinger/hvps-hermes-agent:latest`, a vendor image we
do not control. Its `/opt/data` is where our profiles live, and a vendor update
can revert them. Backups were taken before each change:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 ls -l /opt/data/profiles/*/config.yaml.bak-*
```

| Backup | Restores to |
|---|---|
| `config.yaml.bak-prephase2` | before the Supabase MCP was removed |
| `config.yaml.bak-prestep2` | after MCP removal, before the toolset trim |
| `config.yaml.bak-prestep3` | before `terminal`/`file`/`code_execution` were removed |

Restore with `cat`, never `cp` or `mv` — it preserves the live file's inode,
owner and mode, and the agent runs as `hermes` and cannot read a root-owned
`640` file:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 sh -c \
  'cat /opt/data/profiles/dataengine-supervisor/config.yaml.bak-prestep3 > /opt/data/profiles/dataengine-supervisor/config.yaml'
```

**Expected supervisor state** (`hermes tools` is the supported mechanism — there
is no `agent.disabled_toolsets` key, do not invent one):

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 sh -c \
  'HERMES_HOME=/opt/data/profiles/dataengine-supervisor hermes prompt-size --platform api_server --json'
```

Model `claude-opus-4-8` on `anthropic`; toolsets `skills`, `memory`,
`delegation`; 5 tools; ~44,547 bytes fixed prompt.

---

## Security invariants

Check these after any reboot or Docker change:

```bash
# Nothing public except SSH
ss -ltnp | awk '/0.0.0.0:|\[::\]:/'

# Dashboard blocked on both address families
iptables -S DOCKER-USER; ip6tables -S DOCKER-USER

# The unit that reapplies them
systemctl is-enabled dataengine-firewall.service
systemctl is-active dataengine-firewall.service

# Key-only SSH
sshd -T | grep -E '^(permitrootlogin|passwordauthentication)'
```

Expected: `passwordauthentication no`, `permitrootlogin without-password`, a
DROP rule for port 4860 in both chains, and the firewall unit `enabled` and
`active`.

**From outside the VPS** — the only test that actually proves it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://191.215.42.242:32777/   # expect 000
curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://191.215.42.242:8642/    # expect 000
curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 http://191.215.42.242:3100/    # expect 000
```

A container reporting `healthy` proves nothing about whether a port is exposed.

**Reaching the dashboard legitimately** — through a tunnel, not the internet:

```bash
ssh -i ~/.ssh/srv1927440 -L 4860:127.0.0.1:32777 root@191.215.42.242
# then http://localhost:4860
```

---

## Turning on out-of-band alerts

The banner reaches an admin who is signed in. Degradation that starts at eleven
at night reaches nobody until morning, which for a month-end is the difference
between a fix and an apology.

Add a webhook URL to `services/hermes/.env` and recreate the worker:

```bash
cd /opt/dataengine/services/hermes
echo 'HERMES_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...' >> .env
docker compose up -d --force-recreate      # --force-recreate: a changed
                                           # env_file alone may not recreate
```

Slack and Discord incoming webhooks both work as-is, as does anything that
accepts JSON — the payload carries `text` and `content` with the same sentence.
Those URLs authenticate by being secret, so no signature is sent.

**A Hermes webhook route is different: there the HMAC *is* the authentication,
and an unsigned POST gets `401 {"error": "Invalid signature"}`.** Set
`HERMES_ALERT_WEBHOOK_SECRET` to that route's own secret and the worker signs
with the documented V2 scheme — HMAC-SHA256 over `<timestamp>.<body>`, sent as
`X-Webhook-Signature-V2` with `X-Webhook-Timestamp`. Production is wired this
way, to a route bound to the supervisor profile:

```bash
HERMES_ALERT_WEBHOOK_URL=http://172.16.0.2:8644/p/dataengine-supervisor/webhooks/dataengine-health
HERMES_ALERT_WEBHOOK_SECRET=<the dataengine-health route's secret>
```

Read the secret from the store rather than inventing one; the route and the
worker must hold the same value:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 python3 -c   "import json;print(json.load(open('/opt/data/webhook_subscriptions.json'))['dataengine-health']['secret'])"
```

**It sends once when a fault starts and once when it clears.** A lasting fault
does not re-send; verified in production at 5 checks to 1 alert. `unknown` is
never sent — a check that could not run is logged and shown in the banner, and
the same blip usually stops the worker claiming jobs anyway.

Confirm it is live:

```bash
docker exec hermes-hermes-1 python -c   "from hermes.config import load_config; print(bool(load_config().alert_webhook_url))"
```

To test delivery without waiting for a real fault, send one through the
worker's own signer — which exercises the secret, the URL and the profile
binding in one go:

```bash
docker exec hermes-hermes-1 python3 -c "
import os,sys; sys.path.insert(0,'/app')
from hermes import health
print(health.send_alert(os.environ['HERMES_ALERT_WEBHOOK_URL'],
      {'text':'probe','status':'ok','service':'dataengine-worker'},
      secret=os.environ['HERMES_ALERT_WEBHOOK_SECRET']))" < /dev/null
```

`True` means the gateway accepted it. Prove the authentication is real by
sending the same payload with `secret=''`: it must return `False` and log
`HTTP 401`. A webhook that accepts an unsigned body is not authenticated.

---

## The gateway: one process, four profiles

`hermes gateway list` reports **processes**, not the profiles a running gateway
*serves*. On this box that reads:

```
✓ default (current)        — PID …
✗ dataengine-supervisor    — not running
```

and both lines are true and neither is a fault. `gateway.multiplex_profiles` is
on in `/opt/data/config.yaml` with the three `dataengine-*` profiles
allowlisted, so the single `default` gateway serves all of them at
`/p/<profile>/webhooks/<route>`.

**Do not run `hermes -p dataengine-supervisor gateway start`,** however plainly
the dashboard suggests it. There is one production gateway and one port 8644; a
second process contends for it. The gateway is supervised by s6 inside the
agent container (`/run/service/gateway-default`) and the container is
`restart: unless-stopped`, so it comes back on its own — measured at ~37
seconds after `docker restart`, with a fresh PID and 8644 serving again.

The per-profile s6 service directories exist with a `down` flag and are
deliberately disabled. They live in `/run`, so a container restart clears them.

To check the gateway is *actually* up, probe the port from the container that
calls it rather than reading a status label:

```bash
docker exec dataengine-web-1 node -e '
const net=require("net");const s=net.connect({host:"172.16.0.2",port:8644});
s.setTimeout(4000);
s.on("connect",()=>{console.log("8644 OPEN");s.end()});
s.on("timeout",()=>{console.log("8644 TIMEOUT");s.destroy()});
s.on("error",e=>console.log("8644",e.code));'
```

---

## Webhook routes and their secrets

Hermes stores the HMAC secret **per route**, not per gateway
(`route_config.get("secret", global_secret)`). One shared secret can only ever
be correct for one route — which is how chat returned 401 for two days while
job dispatch through the same gateway succeeded.

Compare fingerprints, never values:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 python3 -c "
import json,hashlib
d=json.load(open('/opt/data/webhook_subscriptions.json'))
for k,v in sorted(d.items()):
    print(f'{k:26s} fp={hashlib.sha256(v.get(\"secret\",\"\").encode()).hexdigest()[:16]} profile={v.get(\"profile\",\"(default)\")}')"
```

against what the web app sends:

```bash
docker exec dataengine-web-1 node -e "
const c=require('crypto');
const fp=s=>s?c.createHash('sha256').update(s).digest('hex').slice(0,16):'(unset)';
console.log('ask', fp(process.env.HERMES_ASK_SECRET||process.env.HERMES_WEBHOOK_SECRET));
console.log('job', fp(process.env.HERMES_JOB_SECRET||process.env.HERMES_WEBHOOK_SECRET));"
```

A route's `profile` field binds it to one profile and **fails closed**: with
`profile: dataengine-supervisor` the route answers only at
`/p/dataengine-supervisor/webhooks/<name>` and returns 404 at the unprefixed
path. Omitting the field binds the route to `default`.

---

## Kanban: the internal multi-agent board

Operator-initiated work only. Nothing in a customer request path creates a card,
and no card touches Supabase — `agent_jobs` remains the queue and the audit
trail for anything a customer is waiting on. Full contract in
`integrations/hermes/kanban/README.md`.

The dispatcher runs **inside the gateway that also serves `/webhooks/ask`**
(`kanban.dispatch_in_gateway`, default on) and sweeps every board once a minute.
A busy board therefore competes with customer chat for the same single core.

```bash
hermes kanban --board dataengine list
hermes kanban --board dataengine runs <id>      # <- the handoff lives here
scripts/kanban-verdict-audit.sh dataengine      # exit 1 on a status/verdict mismatch
```

### Reading a handoff: `runs`, not `show`

`kanban show <id>` reports `result: null, metadata: null` for a card that
completed perfectly. The payload a card hands to its children is stored on the
**run**, not the task row. Use `kanban runs <id>`; `show --json` also carries
`latest_summary` at the top level. Debugging a chain from `show` alone leads to
the conclusion that the handoff is broken when it is working.

### Verifier verdicts

PASS completes the card (`done`); FAIL **blocks** it with a reason prefixed
`VERDICT=FAIL:`. Status then carries the verdict, so a failed check is visible
on the board rather than only in metadata. This exists because a verifier once
detected a real corruption, recorded `verdict: FAIL`, and completed anyway —
leaving a failed verification that looked exactly like a passing one.

Never `request_changes` a verifier card: it resets to `ready` and re-runs
against the same unchanged artefact until the recurrence limit trips.

### Two settings this host depends on

`kanban.max_in_progress: 1` and `kanban.auto_decompose: false` in
`/opt/data/config.yaml`. Unset, `max_in_progress` derives from RAM to **7** —
seven opus-high workers on one vCPU, alongside the gateway answering customer
chat. Both are read per dispatch tick, so a change takes effect within a minute
with no gateway restart.

Adding a board does not raise concurrency: the cap is a host budget, summed
across boards in `kanban_db.count_running_tasks_other_boards`.

### The customer bridge

`kanban_report` is the job kind whose work the board does. It is **off by
default and needs two switches**, on two hosts:

```
apps/web/.env            KANBAN_BRIDGE_ENABLED=true
services/hermes/.env     HERMES_KANBAN_ENABLED=true
                         HERMES_KANBAN_COMMAND=/opt/hermes/.venv/bin/hermes
                         HERMES_KANBAN_DOCKER_HOST=http://kanban-socket-proxy:2375
                         HERMES_KANBAN_CONTAINER=hermes-agent-bwlq-hermes-agent-1
```

### How the worker reaches the board, and why it is not the socket

The board is a SQLite file inside the agent's container; the worker is in its
own, with no shared filesystem and no `hermes` CLI. The obvious bridge -- mount
`/var/run/docker.sock` into the worker and shell out to `docker exec` -- gives
that container root on the host, and that container already holds
`SUPABASE_SECRET_KEY`. One compromise would then be the host *and* every
tenant's data.

So `docker-compose.yml` runs a small nginx in front of the socket, on an
`internal` network the worker shares with it and nothing else, with the
allowlist written out by hand in `deploy/kanban-exec-proxy.conf.template`:
create an exec in **one named container**, start it, read its exit code. Every
other path returns 403, including whatever the Docker API grows next. The worker
speaks that API over HTTP; there is no `docker` binary in its image.

This was first attempted with `tecnativa/docker-socket-proxy` and
`CONTAINERS=1, EXEC=1, POST=1`, and that configuration was **not** narrower than
mounting the socket. Its container ACL is a single prefix match on
`/containers`, so `CONTAINERS=1` also permits `POST /containers/create`. The
check that caught it is worth repeating after any change here:

```bash
docker exec hermes-hermes-1 python -c "
import httpx
b='http://kanban-socket-proxy:2375'
print(httpx.post(b+'/containers/create', json={'Image':'no-such-image-xyz:none'}).status_code)"
# 403 = the proxy refused it.  404 = it reached the daemon, and a real image
#                                    with Privileged would have been host root.
```

Say the remaining risk out loud rather than filing it under secured: exec into
the agent container is enough to read that container's secrets, including the
Management-API OAuth tokens under `/opt/data/mcp-tokens`. This is narrower than
root on the host, not harmless. It is the smallest grant that makes the bridge
work at all.

To take it away: remove `HERMES_KANBAN_DOCKER_HOST` from `.env` and the bridge
stops immediately -- a half-configured transport is refused at startup rather
than silently running the CLI in the wrong container. Remove the
`kanban-socket-proxy` service to take away the capability itself.

Before the first customer job, on the agent host:

```bash
docker exec hermes-hermes-1 python -m hermes.kanban --probe
```

Read-only. It runs every argument list the worker builds and prints what the CLI
accepted, and it checks `create --help` for each flag the bridge depends on by
name. Green against this installation on 2026-08-31. Run it again after any
Hermes upgrade: a renamed flag is a five-second finding here and a mystery three
minutes into a chain. Correct the matching `_argv_*` builder in
`services/hermes/hermes/kanban.py`.

Three CLI facts the bridge depends on, verified rather than assumed, because
each one would have failed quietly:

- `create` takes its **title positionally**. `--title` is a parse error.
- `--workspace` selects the working-directory *kind* (`scratch | worktree |
  dir:<path>`), not a namespace. The per-job namespace is `--tenant`, and
  `list --tenant job-<uuid>` reads exactly one job's cards.
- `block` takes its reason **positionally** and needs `--kind needs_input`. A
  bare block leaves no diagnostic and the dispatcher's promote pass returns the
  card to `ready` — observed within a minute on a probe card. That is the
  difference between stopping a chain and re-running it.

Creation is idempotent at the board: every card carries
`--idempotency-key <correlation>:<role>`, and a repeat create returns the
existing id without overwriting the body. So a worker that dies between creating
a card and recording its id simply runs the same four commands again.

Where a bridged job has got to:

```sql
select j.status, r.phase, r.verdict, r.polls, r.blocked_reason, r.root_task_id
from agent_jobs j join kanban_runs r on r.job_id = j.id
where j.id = '<job id>';
```

`phase` is the real lifecycle — claimed, orchestrating, running, verifying, then
completed, blocked, failed, cancelled or timeout. `agent_jobs.status` stays the
five words the rest of the product understands, and the phase is mirrored into
`progress->>'stage'` for the dashboard.

**A bridged job reads `queued` while it is working.** That is not a stall. It is
handed back to the queue between board checks so a ten-minute chain does not
hold the deployment's only worker, and `available_at` says when it comes back.
A job that really is stuck has a `polls` counter that stops moving.

**`done` is not a pass.** The worker reads the verifier's verdict, checks the
correlation token and the artefact path against what it issued, and downloads
the file before it will record a success. A PASS whose metadata is missing
`job_id`, `correlation_id` or `artifact` is refused — that is a card-body
problem, not a worker problem.

**Cancelling.** A customer may still cancel a bridged job, because it is
`queued`. Doing so cancels the run immediately; the worker stops the cards on
its next idle sweep (within `HERMES_KANBAN_SWEEP_SECONDS`, default five
minutes). A cancelled run whose `cards_stopped_at` is still null after that is
worth a look.

### Recovery

A card that cannot proceed blocks with a reason. Fix the cause, then:

```bash
hermes kanban --board dataengine unblock <id>
```

The dispatcher re-claims it on the next tick and the new run starts clean.

---

## Deploying a change

The VPS pulls over a read-only deploy key; it cannot push, which is deliberate.

```bash
cd /opt/dataengine && git pull --ff-only
cd services/hermes && docker compose up -d --build      # worker
cd ../../apps/web && docker compose -p dataengine -f docker-compose.demo.yml up -d --build
```

If the web build produces inexplicable 500s, delete `.next` first — a directory
left by `next dev` and reused by `next build` produces exactly that.

Verify the worker came back and can still reach the model:

```bash
docker logs --tail 5 hermes-hermes-1
```

Then run one real job and confirm `model_used` is populated — a job that
succeeds proves the queue works, not that the model ran.

---

## Rolling back

| Change | Rollback |
|---|---|
| Any repo change | `git revert <sha>`, pull, rebuild |
| SSH hardening | `rm /etc/ssh/sshd_config.d/00-dataengine-hardening.conf && systemctl reload ssh` |
| Firewall | `systemctl disable --now dataengine-firewall.service` then flush the rules |
| Supervisor toolsets | `hermes tools enable --platform api_server <names>` |
| Supervisor profile | restore a `.bak-*` file with `cat` (see above) |
| LLM health views | `drop view agent_llm_health, agent_job_telemetry` |

---

## Credential rotation

Not yet done, and deliberately deferred rather than forgotten.

- **Root password** — exposed in agent transcripts and shell history. Password
  login is already disabled so it is not an active login path, but rotate it:
  `passwd root`. Key access is unaffected.
- **`API_SERVER_KEY`** — grants terminal access on the agent host. Lives in
  `/opt/data/.env` and in `services/hermes/.env` as `OPENAI_API_KEY`. Both must
  change together or the worker silently falls back to the rule engine.
- **`SUPABASE_SECRET_KEY`** — bypasses RLS. Rotate in the Supabase dashboard,
  then update `services/hermes/.env` and `apps/web/.env`.

After any rotation, run one real job and check `agent_llm_health`. A mismatched
key does not error; it degrades.
