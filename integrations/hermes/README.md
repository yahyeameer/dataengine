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
| `dataengine-job-prompt.md` | Uploaded as-is to `/opt/data`. The agent reads it at run time, so no template rendering touches it. |

## 1. Upload both files

In the Hermes UI, open **FILES**, confirm the path reads `/opt/data`, and drag
both of these in from `integrations/hermes/`:

```
dataengine-job-prompt.md     6687 bytes
route-prompt.txt             1240 bytes
```

They are named for their destination, so there is nothing to rename — drop them
and they are in the right place under the right names.

Neither can be fetched from this repository: it is private, which is correct and
should stay that way. Nothing in this integration needs the agent reading the
source, and granting it access to save an upload would trade a real boundary for
a small convenience.

Confirm they landed intact. A truncated upload produces a route that reports as
created and then fails halfway through the first real job:

```bash
docker exec hermes-agent-bwlq-hermes-agent-1   wc -c /opt/data/dataengine-job-prompt.md /opt/data/route-prompt.txt
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
HERMES_WEBHOOK_SECRET=<the route's secret>
HERMES_WEBHOOK_SIGNING=github
HERMES_WEBHOOK_URL=http://172.16.0.2:8644
HERMES_JOB_ROUTE=dataengine-job
```

`HERMES_JOB_ROUTE` must equal the subscription's **name**. A Hermes route's name
is its URL -- `dataengine-job` serves `/webhooks/dataengine-job`, and there is no
generic endpoint. Get it wrong and the gateway answers 404 on every job while
the failure message talks about the gateway not accepting the job, which sends
you looking at the secret.

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

## The webhook turn has no tools (2026-08-30) — this integration does not run

**This section retracts the one it replaces.** The previous text claimed a
webhook turn had `terminal`, signed an HMAC and posted a callback that returned
HTTP 200. That probe was run in a CLI / default-agent context — `docker exec …
hermes-agent-1`, which carries the `hermes-cli` toolset — not in a
`webhook:<route>:<delivery>` gateway turn. It validated the wrong session type,
and it was the assumption this whole integration was shaped around.

What a real webhook turn actually has, measured over five deliveries on
2026-08-29 and 2026-08-30 (two live jobs, one controlled probe on a route
recreated without `--skills`, and the history of the two pre-existing routes):

| Capability | In a webhook turn |
|---|---|
| `terminal` | **Absent** |
| Filesystem read | **Absent** — it cannot open `/opt/data/dataengine-job-prompt.md` |
| Outbound HTTP | **Absent** — a controlled listener logged zero requests |
| Analyzit plugin tools | **Absent** — never fired on any delivery |
| Supabase MCP | **Present**, and working |

The mechanism is a platform→toolset binding, not anything on the route.
`hermes_cli/platforms.py` gives the webhook platform a `default_toolset` of
`hermes-webhook`, and the gateway's `config.yaml` has no `platform_toolsets:
webhook:` entry to override it. Three things follow that cost a day to learn:

- **`--skills` is not a tool grant.** Skills are prompt context. Recreating the
  route with no skills at all changed the tool inventory not at all.
- **The failure does not look like a failure.** With no tools and no human, the
  turn asks a clarifying question and spins to its iteration ceiling. DataEngine
  receives a question where it expects a result. `analyzit-workbook-upload` has
  dead-ended this way on every delivery since 2026-08-25 and was assumed to work.
- **`ask` works only because it needs nothing else.** Its whole job is one
  `execute_sql`, and the Supabase MCP is the one tool the webhook toolset carries.

So `route-prompt.txt` and `dataengine-job-prompt.md` describe work the receiving
turn cannot perform. Both are written against `terminal`: read the spec off
disk, GET the input, PUT the artefacts, sign and POST the callback. Every one of
those is unavailable. Nothing in this integration will run until the toolset
question below is settled — and it is a decision, not a bug fix.

### The toolset grant is a security decision

`platform_toolsets` is keyed by **platform, not route** — the webhook store holds
seven fields per route and none of them is a toolset. So adding `terminal` for
`dataengine-job` adds it for *every* webhook route on that gateway, present and
future, including routes the agent creates for itself (`ask` is one).

That has to be weighed against what those turns already hold. The Supabase MCP
in the webhook toolset is not a database API key. It is a **Management-API OAuth
credential** (issuer `api.supabase.com`, tokens under `/opt/data/mcp-tokens/`)
exposing ~20 project-admin tools including `execute_sql`, `apply_migration` and
`deploy_edge_function`. It runs at admin identity, so **RLS does not constrain
it** — RLS binds the `anon` and `authenticated` roles behind PostgREST, and this
connection is neither.

Which means the claim made further up this file — that the agent holds no
Supabase credentials and the signed URLs are the whole of its access — is **true
of the `dataengine-job` design and false of the box it runs on**. Tenant
isolation for `ask` today rests on its prompt saying which `workspace_id` to
touch and a `WHERE request_id = …` clause. Nothing at the credential or database
layer would stop that turn writing another firm's rows.

Fix that before granting anything further. Adding shell to a session that
already holds project-admin SQL is a different proposition from adding shell.

## A hazard on the agent's disk

`/opt/data` contains a checkout of **AI-Data-Operations-Platform** — the
abandoned predecessor of this project. It shares this one's whole vocabulary:
the same job kinds, a `hermes` module at the same path, and a documented tool
layer at `/api/tools/{tool}` that was designed and never actually built.

An agent that goes looking for context mid-job will find a contract that no
longer exists. `dataengine-job-prompt.md` opens by telling it the payload is the only source of
truth and naming that directory specifically, which is the cheap fix.

Leave the checkout in place — it is the operator's, and deleting things from a
running agent's persistent volume to fix a prompt problem is the wrong trade.
Renaming it to something that does not read as this project would not hurt.
