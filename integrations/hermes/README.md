# The Hermes side of the integration

Everything DataEngine needs is in the repository. This is the other half: one
webhook subscription on the agent, and the prompt it runs.

There is **no new skill to write**. A Hermes webhook route is a name, a list of
events, and a prompt that becomes an agent turn — the `analyzit-*` skills the
agent already carries are what that turn reaches for. The case study in
`hermes-webhook-integrations/references/analyzit-case.md` establishes the shape;
this is the same thing pointed at a job instead of a question.

## Two files, and why

`hermes webhook subscribe --prompt` takes a **string**, not a file, and that
string is a template: it substitutes `{dot.notation}` references against the
webhook payload before the agent ever sees it.

That rules out passing the runbook as `--prompt`. It contains three brace
patterns a renderer would try to substitute — a JSON example, an f-string
`{sig}`, and the path `/api/tools/{tool}` — and the corruption would be silent.

So the route carries a short template, and the long specification lives on disk:

| File | Role |
|---|---|
| `route-prompt.txt` | Passed as `--prompt`. Short, and every brace in it is a deliberate payload reference. |
| `prompt.md` | Uploaded to `/opt/data/dataengine-job-prompt.md`. The agent reads it at run time, so no template rendering touches it. |

## 1. Upload the runbook

Drag `prompt.md` into **FILES** in the Hermes UI and name it
`dataengine-job-prompt.md`. It cannot be fetched from this repository — the repo
is private, which is correct and should stay that way.

Confirm it landed intact before continuing. A truncated upload produces a route
that reports as created and fails halfway through the first real job:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1   wc -c /opt/data/dataengine-job-prompt.md      # expect 6687 or thereabouts
```

## 2. Create the route

Generate the secret yourself rather than letting the gateway mint one. Both
sides need the same value, and a secret you already hold is one you never have
to transcribe out of a terminal — which is the exact step that cost the case
study an afternoon over `LW` against `Lw`:

```bash
openssl rand -hex 32        # keep this; it goes in apps/web/.env too
```

Then ask the agent, in **CHAT**, to run the subscription through Python's
`subprocess` with an argument list — no shell, no interpolation:

> Create a Hermes webhook subscription. Do it from Python with `subprocess.run`
> and an argument list, not through a shell.
>
> - name: `dataengine-job`
> - `--events job.dispatched`
> - `--prompt`: the exact contents of `/opt/data/route-prompt.txt`, read from
>   the file
> - `--secret`: `<the value from openssl above>`
> - `--skills`: `analyzit-data-cleaning,analyzit-cleaning-recipes,analyzit-data-analysis,analyzit-polars,analyzit-duckdb,analyzit-accounting,analyzit-reporting`
> - `--description`: `DataEngine cleaning and export jobs`
>
> Then run `hermes webhook list` and show me the stored prompt verbatim, so I
> can check the payload references survived.

`--skills` scopes the turn to what the work needs instead of loading all 91.
On a box with one CPU core that is worth doing.

## 3. Put the same secret in DataEngine

In `apps/web/.env`:

```
HERMES_WEBHOOK_SECRET=<the same value you passed to --secret>
HERMES_WEBHOOK_SIGNING=github
HERMES_WEBHOOK_URL=http://172.16.0.2:8644
```

Signing is HMAC-SHA256 over the exact raw request body, sent as
`X-Hub-Signature-256: sha256=<hexdigest>` alongside `X-GitHub-Event` — what this
installation's `hermes-webhook-integrations` skill documents, and what
`HERMES_WEBHOOK_SIGNING=github` selects.

If you ever do let the gateway generate the secret instead, read it back with
`hermes webhook list` and copy it rather than retyping it. The case study records
an afternoon lost to a single letter's case (`LW` against `Lw`), and the only
symptom was `Invalid signature`.

## 4. Verify the route answers

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
