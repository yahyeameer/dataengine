# Kanban, for DataEngine

Hermes Kanban is a durable SQLite task board. The dispatcher runs **inside the
gateway that also answers customer chat** (`kanban.dispatch_in_gateway`,
default on), sweeps every board once a minute, and spawns the assigned profile
as a real CLI session.

That last part is the whole reason this is worth having.

## What it is for, and what it is not for

A Kanban worker is spawned as `hermes -p <profile> --cli … kanban task <id>`,
so it gets the `hermes-cli` toolset: `terminal`, `process`, `read_file`,
`write_file`, `patch`, `search_files`, web. A webhook turn on the same
installation gets four tools — `web_search`, `web_extract`, `vision_analyze`,
`clarify` — and cannot run code. Measured, not assumed: in the 2026-08-31 smoke
test the analyst profiled a CSV by writing and running a Python script, which
the webhook path cannot do at all.

So Kanban is the only path here where a DataEngine agent can *do* data work
rather than describe it.

Do not take a worker's word for its own tool inventory. On 2026-08-31 a verifier
announced that "code execution is blocked in headless mode" and re-derived its
figures by hand; no denial appears in any log, and the analyst on the same board
minutes earlier had run `csv.DictReader` without trouble. It reached the right
answer, but its self-report was wrong. Check the profile log for an actual
denial before believing a capability is missing.

**It is not a queue for customer work.** It has no RLS, no `org_id`, and no
per-workspace tenancy; its `tenant` field is a namespace string, and the board
is the only real boundary. `agent_jobs` remains the queue, the lease and the
audit trail for anything a customer is waiting on. If a Kanban chain ever needs
to touch customer data, an `agent_jobs` row triggers it and the Python worker
writes the result back — the Kanban worker never talks to Supabase.

Operator-initiated only. Nothing in a customer request path creates a card.

## The board

```bash
hermes kanban boards create dataengine     # own DB, workspaces, logs, dispatch loop
hermes kanban --board dataengine list
```

Boards are a hard boundary: tasks cannot link across them. `default` is the
vendor board and is left alone.

Creating a second board does **not** raise concurrency. `max_in_progress` is a
host budget, not a per-board one — `kanban_db.py` sums `running` across every
other board before each tick (`count_running_tasks_other_boards`), precisely so
that N boards cannot each spawn N workers.

## Two settings this host depends on

```yaml
kanban:
  max_in_progress: 1     # 1 vCPU, shared with the gateway serving customer chat
  auto_decompose: false  # otherwise an auxiliary LLM fans out triage cards every tick
```

Unset, `max_in_progress` derives from RAM and resolves to **7** here: seven
`claude-opus-4-8` workers at `reasoning_effort: high` on one core. Do not raise
it without moving the agent off this box.

## Reading a handoff: `runs`, not `show`

The single most confusing thing about this system.

A card hands off to its children through `kanban_complete(summary=…,
metadata=…)`, and that payload is stored on the **run**, not on the task row:

```console
$ hermes kanban show t_edb86f18 --json | jq '.task | {result, metadata}'
{ "result": null, "metadata": null }        # <- looks like nothing happened

$ hermes kanban runs t_edb86f18 --json | jq '.[-1].metadata'
{ "row_count": 30, "expected": { "duplicate_rows": 2, … } }   # <- the handoff
```

`show` is for status, parents, children, comments and events. `runs` is for
what a card actually produced. Anyone debugging a chain from `show` alone will
conclude the handoff is broken when it is working.

`show --json` does expose `latest_summary` at the top level, which is the prose
half of the same thing.

## Verifier protocol: status must carry the verdict

**PASS → `kanban_complete` (card becomes `done`).
FAIL → `kanban_block(reason="VERDICT=FAIL: …")` (card becomes `blocked`).**

Use `integrations/hermes/kanban/verifier-card.md` as the card body.

`kanban_block` has **no `metadata` parameter** — only `task_id`, `reason` and
`kind`. A verifier that tries to attach structured detail to a block loses it
silently (observed: `metadata: null` on the run). So the detail goes in a
`kanban_comment` first, and the `VERDICT=FAIL:` prefix on the reason is the
machine-readable half. `kanban_complete` does carry metadata, which is why the
PASS path can use it.

The reason is a defect we watched happen. A verifier correctly caught a
corrupted figure, wrote `{"verdict":"FAIL"}` into its metadata, and then called
`kanban_complete`. The card went to `done`. On the board a failed verification
looked exactly like a passing one, and the only way to know was to open the run
metadata of a card nobody had a reason to open.

Never `kanban_request_changes` on a verifier card: it resets the card to
`ready`, and the dispatcher re-runs it against the same unchanged artefact until
the block-recurrence limit trips.

Because that protocol lives in a prompt and a model already deviated from it
once, there is a detection half:

```bash
scripts/kanban-verdict-audit.sh dataengine   # exit 1 if any `done` card is not PASS
```

Run it after any chain that includes a verifier.

## Failure and recovery

Verified on 2026-08-31: a card whose input was missing called `kanban_block`
with a precise reason and refused to fabricate figures. Supplying the input and
running `hermes kanban unblock <id>` re-dispatched it, and the second run
measured the new file correctly with no carry-over from the first attempt.

```bash
hermes kanban --board dataengine unblock t_xxxxxxxx
```

Still unverified here, documentation only: the `gave_up` circuit breaker after
`failure_limit` consecutive crashes, and stale-lease reclaim after an hour
without a heartbeat. Both need induced crashes or an hour-long stall against the
gateway that serves customer chat, which is not worth doing to watch a counter.

## Costs

Four Opus-high turns for a four-card chain, serialised at `max_in_progress: 1`.
The smoke test measured 68s, 55s, 87s and 50s of agent time plus up to a minute
of dispatcher latency per hop. Fine for a nightly report. Wrong for anything
per-request.
