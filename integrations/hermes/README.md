# The Hermes side of the integration

Everything DataEngine needs is in the repository. This is the other half: one
webhook subscription on the agent, and the prompt it runs.

There is **no new skill to write**. A Hermes webhook route is a name, a list of
events, and a prompt that becomes an agent turn — the `analyzit-*` skills the
agent already carries are what that turn reaches for. The case study in
`hermes-webhook-integrations/references/analyzit-case.md` establishes the shape;
this is the same thing pointed at a job instead of a question.

## 1. Create the route

On the VPS:

```bash
docker exec -it hermes-agent-bwlq-hermes-agent-1 \
  hermes webhook subscribe dataengine-job \
    --events job.dispatched \
    --prompt "$(cat prompt.md)"
```

`--events job.dispatched` must match the `X-GitHub-Event` header DataEngine
sends. That name is set in `apps/web/src/lib/hermes.ts` (`dispatchJob`), and the
two have to agree or the gateway accepts the POST and routes it nowhere.

## 2. Take the secret it generates

The gateway stores a per-route secret in `~/.hermes/webhook_subscriptions.json`
and does not display it again:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1 hermes webhook list
```

Copy it verbatim into `apps/web/.env` as `HERMES_WEBHOOK_SECRET`. The case study
records an afternoon lost to a one-letter case difference (`LW` against `Lw`)
that presented only as `Invalid signature` — compare it character by character
rather than by eye, and never retype it.

Signing is HMAC-SHA256 over the exact raw request body, sent as
`X-Hub-Signature-256: sha256=<hexdigest>`. DataEngine already does this; the
`HERMES_WEBHOOK_SIGNING=github` default in `.env.docker.example` selects it.

## 3. Verify before wiring the app

```bash
curl -s http://172.16.0.2:8644/health

# Signed by hand, the way the case study proved the route works:
BODY='{"job_id":"00000000-0000-0000-0000-000000000000","kind":"noop"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -i -X POST http://172.16.0.2:8644/webhooks/ask \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: job.dispatched' \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY"
# → {"status":"accepted",...}
```

## What DataEngine sends

```json
{
  "request_id": "…", "job_id": "…", "kind": "apply_cleaning",
  "workspace_id": "…", "dataset_id": "…", "dataset_version_id": "…",
  "input":  { "url": "<signed GET, 1h>", "filename": "customer.xlsx", "byte_size": 184320 },
  "output": { "export_url": "<signed PUT>", "export_path": "…", "format": "xlsx",
              "parquet_url": "<signed PUT>", "parquet_path": "…" },
  "callback_url": "http://web:3100/api/hermes/jobs/result",
  "expires_at": "2026-08-29T18:00:00.000Z"
}
```

The agent holds **no Supabase credentials**. Those URLs are the whole of its
access: one object it may read, two keys it may write, minted only after the
signed-in accountant's membership was proven. It cannot reach another firm's
data by asking differently, because what it has is not a request — it is a pair
of URLs already scoped to one workspace.

## What DataEngine expects back

`POST` to `callback_url`, signed the same way, `X-GitHub-Event: job.result`:

```json
{ "job_id": "…", "status": "running|succeeded|failed",
  "progress": { "stage": "cleaning" },
  "result": { "export_path": "…", "parquet_path": "…", "row_count": 1204,
              "dataset_name": "…", "source_filename": "customer.xlsx",
              "bucket": "exports" },
  "error": null }
```

Send `running` as work proceeds — it renews the job's lease and drives the
progress text the accountant sees. `succeeded` records the dataset version and
releases the download. Duplicate reports are safe: a terminal job is returned
unchanged rather than corrupted.

`job_id` is the only field read from the body. Workspace, org and dataset come
from the job row, so a report cannot name a tenancy it was not given.

## ⚠ The one thing still unverified

**Whether an agent turn can make an outbound HTTP POST**, and whether it can
HMAC-sign it with the route's secret. Everything above assumes it can. The case
study does not say either way, and the old repo's planned tool layer — the place
this would have been proven — was documented but never actually built
(`scripts/tool-layer-smoke.ts` exists in that repo; the route it tests does not).

Check the agent's 29 toolsets for an HTTP or fetch tool before relying on this.

**If it cannot**, the fallback needs no change to DataEngine's schema: the agent
writes its result into `hermes_answers` the way the existing ask path already
does, and a small poller in the web app forwards that row into the same callback
handler. Say so and that is a contained change, not a redesign.
