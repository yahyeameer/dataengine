# The Hermes side of the integration

Everything DataEngine needs is in the repository. This is the other half: one
webhook subscription on the agent, and the prompt it runs.

There is **no new skill to write**. A Hermes webhook route is a name, a list of
events, and a prompt that becomes an agent turn — the `analyzit-*` skills the
agent already carries are what that turn reaches for. The case study in
`hermes-webhook-integrations/references/analyzit-case.md` establishes the shape;
this is the same thing pointed at a job instead of a question.

## 1. Create the route

Ask the agent to do it rather than composing the command by hand. The prompt is
several kilobytes of markdown containing `$`, backticks and quotes, and
`--prompt "$(cat prompt.md)"` runs all of it through shell expansion first --
which mangles the prompt silently and leaves a route that looks created and
behaves oddly.

Upload `prompt.md` through **FILES** (it lands in `/opt/data`), then in **CHAT**:

> Run `hermes webhook subscribe --help` and show me the options. Then create a
> subscription named `dataengine-job` for the event `job.dispatched`, using the
> full contents of `/opt/data/prompt.md` as its prompt — read it from the file
> rather than pasting it through the shell. Then run `hermes webhook list` and
> show me the result.

The agent has `terminal`, so it can read the help, pick the right flag (a
`--prompt-file` if one exists) and avoid the quoting problem entirely.

**Check the result yourself.** Run `hermes webhook list` in a terminal rather
than relying on the agent's summary of what it did — a route whose prompt was
truncated reports as created, and the failure only appears later as an agent
turn that stops halfway with no explanation.

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

## Verified against the running agent (2026-08-29)

The open question was whether an agent turn could reach back out and sign what
it sent. It can. Tested against a listener on `hermes-agent-bwlq_default`:

| Capability | Evidence |
|---|---|
| Receives job information | Webhook body reaches the turn (case study, and the probe run) |
| HTTP GET the input | `urllib.request` completed a round trip to an external host |
| Analyzit cleaning | 91 skills installed and enabled |
| HTTP PUT the artefact | Same library, same tool |
| HMAC-SHA256 signing | Digest reproduced exactly, byte for byte |
| POST the callback | HTTP 200 from `http://probe:9999/` |
| Report success/failure | Same channel |

The tool is **`terminal`**, running Python with the standard library —
`urllib.request` for HTTP, `hmac` and `hashlib` for signatures. No third-party
package is needed and none should be installed.

That is more capable than a constrained HTTP tool would have been: the whole job
loop can run as one script, which is why `prompt.md` gives a concrete skeleton
for the callback rather than describing it. The single failure mode worth
guarding is serialising the body twice — signing one JSON encoding and posting
another produces a valid-looking signature that never verifies, and reads as a
wrong secret. The skeleton serialises once, on purpose.

One incidental finding: the agent could not fetch this repository's README over
HTTP, because the repository is private. That is correct and should stay that
way — nothing in this integration requires the agent to read the source. Do not
grant it repository access to make a test pass.

## A hazard on the agent's disk

`/opt/data` contains a checkout of **AI-Data-Operations-Platform** — the
abandoned predecessor of this project. It shares this one's whole vocabulary:
the same job kinds, a `hermes` module at the same path, and a documented tool
layer at `/api/tools/{tool}` that was designed and never actually built.

An agent that goes looking for context mid-job will find a contract that no
longer exists. `prompt.md` opens by telling it the payload is the only source of
truth and naming that directory specifically, which is the cheap fix.

Leave the checkout in place — it is the operator's, and deleting things from a
running agent's persistent volume to fix a prompt problem is the wrong trade.
Renaming it to something that does not read as this project would not hurt.
