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
