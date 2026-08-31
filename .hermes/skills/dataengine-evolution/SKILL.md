---
name: dataengine-evolution
description: How to improve DataEngine without breaking it. Use for any change to the worker, the queue, agent profiles, Supabase schema, or the deployed VPS — and before claiming any improvement is done.
version: 1.0.0
---

# DataEngine Evolution

## Purpose

Use this skill whenever you are about to change DataEngine: its worker, its
queue, its agent profiles, its database, its deployment, or its configuration.

Improving a system that real accounting firms depend on is a different activity
from improving a codebase. The difference is not care — it is that **you must
be able to prove afterwards that you did not break anything**, and most of the
ways this system breaks do not announce themselves.

The loop is:

> **Observe → Diagnose → Propose → Test → Safely Apply → Verify → Document → Learn**

Self-improvement is not permission to rewrite code you find inelegant, to trade
intelligence for tokens, or to declare success from a local test run.

---

## The architecture you are changing

Verify anything here against the repository before relying on it. Where this
document and the code disagree, the code is right and this document is stale —
fix it.

```
DataEngine
├── apps/web ................ Next.js 16, 8 API routes, per-route auth (no middleware)
├── Supabase ................ Auth, RLS on all tables, 19 tables
│   ├── datasets / dataset_versions ..... lineage; versions are never overwritten
│   ├── raw_uploads ..................... the file as it arrived
│   ├── agent_jobs ...................... the queue; the single record of work
│   ├── proposed_changes ................ pending → approved → applied
│   └── audit_logs ...................... append-only
├── Hermes (vendor image, floating :latest)
│   ├── dataengine-supervisor ... claude-opus-4-8 / anthropic — reached by the worker
│   ├── dataengine-analyst ...... reached by Kanban delegation
│   └── dataengine-reporter ..... reached by Kanban delegation
├── services/hermes ......... the Python worker, one job at a time, polls the queue
│   └── 10 handlers: parse_workbook, profile_dataset, propose_cleaning,
│       apply_cleaning, replay_recipe, query_dataset, reconcile_sources,
│       generate_report, export_dataset, categorize_dataset
└── srv1927440 .............. single-core VPS; nothing public but SSH
```

The dashboard never calls the agent. It writes a row to `agent_jobs`; the worker
claims it. Everything good about this system's reliability follows from that one
decision, so be slow to change it.

The worker reaches the model at
`http://172.16.0.2:8642/p/dataengine-supervisor/v1` — profile selection is by
**path**, not by the `model` field. `/v1/models` does not enumerate profiles.

---

## Invariants

These are not preferences. A change that weakens one is wrong even when it
passes every test, and "the tests pass" is not an argument against this section.

### Security

- Never weaken authentication, authorization, tenant isolation, or RLS.
- Never reintroduce the Supabase **Management-API** MCP into an agent profile.
  It bypasses RLS entirely and was deliberately removed from all three
  `dataengine-*` profiles. Only the human owner may ask for it back.
- Never publish a port to make something convenient. `8642` and `3100` are
  loopback-only; the Hermes dashboard is filtered by `dataengine-firewall`.
- Never log a secret. `API_SERVER_KEY` grants terminal access to the agent host;
  a webhook URL is a bearer credential. Both belong in the same tier as
  `SUPABASE_SECRET_KEY`.

### Data integrity

- Never silently modify customer data. Cleaning produces a **new version**;
  nothing is overwritten.
- Never delete datasets, versions, jobs, proposals, evidence or audit rows as
  part of an optimization. Growth is not a bug to fix by deletion.
- Never bypass a validation because a model's answer looked reasonable. The
  validation exists because reasonable-looking wrong answers are the failure
  mode.

### LLM integrity

- Never let a weaker model quietly stand in for the intended one.
- **Cheaper is not better. Fewer tokens is not a better agent.** Removing tool
  schemas the agent cannot use is a real optimization. Lowering model
  capability, reasoning effort, context, validation or safety checks is not —
  it is a trade, and only the human owner may make it.
- Do not change the supervisor's model, provider or reasoning configuration for
  cost alone. Measured evidence plus explicit approval, or not at all.
- A successful LLM job must still expose `model_used`. If a change makes that
  field disappear, the change is broken, however green the tests are.

### Queue integrity

Preserve, unless you have evidence the current behaviour is wrong:

- `claim_agent_job`'s `for update skip locked` — this is what makes two workers
  safe with no coordination.
- Expired-lease reclaim: `status='running' AND lease_expires_at < now()` is the
  entire crash-recovery story.
- `finish_agent_job` refusing a report from a worker that no longer holds the
  job, and returning a terminal job unchanged so duplicate reports are safe.
- Worker heartbeats and `enqueue_agent_job`'s deduplication.

Do not write a lease reaper. The queue already is one.

### Categorisation integrity

- Keep the quality gates in `categorize_quality()` and keep the reviewer seeing
  the full mapping, the dropped count and the singleton count.
- **Never invent a confidence score.** The model is not asked how sure it is
  because it does not know, and a number invented at that layer is worse than
  none — a reviewer trusts a percentage far more than prose.
- Never silently discard model output. Dropping is fine; dropping quietly is not.

### Deployment integrity

Every production change needs a rollback path, a test, a verification, and
evidence. **Never claim a deployment succeeded on the strength of a local test.**

---

## Improvement hierarchy

Work top-down. Never spend effort on a lower tier while a higher-tier problem is
open — a faster query on a system with a tenant-isolation bug is not progress.

| | Tier | Examples |
|---|---|---|
| **P0** | Security & data integrity | tenant isolation, secret exposure, authorization bugs, unsafe DB access, destructive operations, customer-data corruption |
| **P1** | Reliability | worker or queue failure, LLM degradation, failed deploys, missing telemetry, **any silent fallback** |
| **P2** | Performance & cost | prompt tokens, tool schemas, redundant model calls, slow queries, memory, throughput — **measured, never guessed** |
| **P3** | Product & UX | confusing workflows, poor error handling, accessibility, reporting experience |
| **P4** | Experimental intelligence | new capabilities, new specialists, better reasoning strategies |

---

## The production-change protocol

Follow this in order. Steps 6, 7, 12 and 14 are the ones that get skipped under
time pressure, and they are the ones that catch real damage.

1. **Identify** the problem in one sentence.
2. **Gather evidence** — logs, telemetry, a query, a reproduction.
3. **Find the root cause.** Not the symptom.
4. **Identify affected components.**
5. **Identify invariants at risk.** Name them explicitly.
6. **Establish a rollback point** — a commit, a `.bak-` file, a backup table.
7. **Capture a baseline measurement.** Without it, step 14 is impossible.
8. **Design the smallest viable change** (see the budget below).
9. **Apply it.**
10. **Run the automated tests** — `pytest services/hermes/tests/`, `npm run test:health`.
11. **Run the relevant integration tests** — `scripts/agent-smoke.ts`, `rls-smoke.ts`, `agent-e2e.ts`.
12. **If production behaviour changed, run a real acceptance job** through the
    shipped worker. Not a replica of it.
13. **Verify the correct success signal** — see below.
14. **Compare against the baseline.**
15. **Look for regressions** in the things you did not change.
16. **Document** the change and the evidence.
17. Only now is it done.

### The success signal is not "succeeded"

A job reaching `succeeded` proves the queue worked. It does **not** prove the
model ran — every model call degrades to the rule engine on a timeout, an
unreachable endpoint, malformed JSON or a missing key, and the job still
succeeds with plainer prose.

For an LLM-backed job, check the model actually ran:

```sql
-- propose_cleaning NESTS it; every other kind is top level.
-- Use llm_model_used(result), or the coalesce form, never a flat lookup.
select job_id, kind, status, worker_id, model_used, llm_fell_back
from agent_job_telemetry where job_id = '<uuid>';

-- Fleet-wide:
select * from agent_llm_health;   -- degraded > 0 is the alert
```

A flat `result->>'model_used'` reads null for `propose_cleaning`, the
highest-volume task, and looks like total degradation. That mistake has already
been made once in this project.

---

## Evidence discipline

Label every finding. Never promote one rung without doing the work.

| Label | Means |
|---|---|
| **Verified** | You ran it and saw the result |
| **Measured** | You have a number, with the method stated |
| **Inferred** | Follows from something verified, but not observed directly |
| **Estimated** | A calculation from assumptions. Say which assumptions |
| **Unverified** | You believe it. You have not checked |

Never present an estimate as a measurement. When you have not checked something,
the correct output is the word *unverified*, not silence.

**Specific traps in this system**, each of which has already produced a wrong
conclusion here:

- **Worker liveness** is `agent_workers.last_seen_at`, never `claimed_at`. An
  idle worker polls every 3 seconds and never updates a claim timestamp; a stale
  claim on an empty queue means nothing.
- **CI** must be inspected remotely (`gh run list --repo <owner>/<repo>`).
  Passing locally proves nothing — and check the repo name, because a stale
  `origin` can point `gh` at an entirely different repository.
- **Deployment** must be verified in the running container, not the source tree.
  `git pull` can fail, and `docker compose up -d` will happily rebuild the old
  checkout and report success.
- **A container reporting `healthy`** says nothing about whether a port is
  exposed. Probe from outside the host.
- **A config change may not take effect.** A changed `env_file` alone did not
  recreate the container; `--force-recreate` was needed.
- **An invented config key fails silently.** `agent.disabled_toolsets` does not
  exist. The supported mechanism is `hermes tools disable --platform <p>`.

---

## Improvement budget

Prefer the **smallest safe change**. If one config value, one focused function,
one migration, one test or one monitoring query solves it, do that and stop.

A broad refactor needs correspondingly stronger evidence: a measurement showing
the current design is the problem, not a feeling that it could be nicer. The
best change this project has made was deleting one call; the worst near-miss was
proposing to rebuild a working queue.

---

## Autonomy and its limits

Do these independently: read code, read logs, examine tests, analyse telemetry,
find root causes, propose improvements, implement safe ones, run tests, verify,
document.

**Stop and get explicit human approval for:**

- destructive database operations, or deleting any production data
- credential changes or rotation
- authentication, authorization or tenant-isolation changes
- exposing anything to a network
- changing the supervisor's model, provider or reasoning configuration
- changing a security boundary
- large architectural migrations

The goal is a high-agency engineer with guardrails — neither a timid assistant
that asks permission to read a file, nor a script that reorganises production at
three in the morning.

---

## Measure it

Every meaningful improvement carries a before and after where one exists:
latency, tokens, prompt size, memory, CPU, throughput, error rate, retry rate,
queue latency, CI duration, query time.

If no metric is meaningful, say so and justify the change on other grounds —
correctness, safety, clarity. **Do not manufacture a metric to look rigorous.**
A fabricated number is worse than an honest "not measurable" because it survives
into decisions.

---

## Learn from being wrong

When an assumption turns out to be false, record it — the assumption, the
evidence that broke it, the correct interpretation, and the rule that prevents a
repeat. Use the memory mechanism this installation already has (`hermes memory`,
and the curator that reviews it); do not build a parallel one.

Worked examples from this system:

> **Assumed:** an old `claimed_at` means the worker is not polling.
> **Evidence:** the worker was `Up (healthy)` and its heartbeat was 29s old; the
> queue was simply empty.
> **Correct:** worker liveness is heartbeat age.
> **Rule:** never infer liveness from work timestamps.

> **Assumed:** the three local CI jobs pass, so CI passes.
> **Evidence:** six consecutive red runs on GitHub — root `npm ci` never
> installed `apps/web`.
> **Correct:** local success says nothing about the runner's environment.
> **Rule:** read the remote run before claiming CI works.

> **Assumed:** a `webhook` turn has the same tools as a chat turn.
> **Evidence:** five deliveries with no terminal, no filesystem, no outbound HTTP.
> **Correct:** toolsets are bound per platform.
> **Rule:** prove a capability in the exact session type that will use it.

> **Assumed:** one gateway means one HMAC secret, so a 401 on one route means
> the secret is wrong everywhere.
> **Evidence:** `/webhooks/dataengine-job` returned 202 and `/webhooks/ask`
> returned 401 in the same second, from the same container, with the same
> header and the same secret. `_handle_webhook` resolves
> `route_config.get("secret", global_secret)`.
> **Correct:** Hermes keys the secret to the **route**. A shared secret can
> only ever be right for one of them.
> **Rule:** compare secret *fingerprints* per route before touching a secret.
> A symptom that looks intermittent across a product is often deterministic
> per route — ask which route, not which hour.

> **Assumed:** "the gateway is stopped" because the dashboard and
> `hermes -p dataengine-supervisor gateway status` both say so.
> **Evidence:** port 8644 was open and serving from the web container the whole
> time; `gateway.multiplex_profiles` was on with the three dataengine profiles
> allowlisted, and the `default` gateway was serving all of them.
> **Correct:** `gateway list` enumerates gateway *processes*, not the profiles
> a running gateway *serves*. A multiplexing deployment has one process and
> N-1 profiles that correctly report "not running".
> **Rule:** never run `hermes -p <profile> gateway start` on this box to
> satisfy that message. There is one production gateway; a second would
> contend for 8644. Test the port, not the label.

> **Assumed:** a card that completed did the thing it was asked to do, so
> `status: done` on a verifier means the verification passed.
> **Evidence:** a verifier correctly detected a corrupted figure, wrote
> `{"verdict":"FAIL"}` into its run metadata, and then called
> `kanban_complete`. The card went to `done`, indistinguishable on the board
> from a passing check.
> **Correct:** execution status and business verdict are different facts. A
> tool that finished successfully can be reporting a failure.
> **Rule:** make the status carry the verdict — PASS completes, FAIL blocks —
> and audit the pairing, because a protocol that lives in a prompt is advisory
> and this model already deviated from it once.

> **Assumed:** `kanban show <id>` shows what a card produced.
> **Evidence:** `show --json` returned `result: null, metadata: null` for a
> card whose handoff was intact and had already been consumed by its child.
> **Correct:** the handoff is stored on the **run**, not the task row.
> `kanban runs <id>` is where it lives.
> **Rule:** before concluding a handoff is broken, check you are reading the
> place it is written.

> **Assumed:** the worker heartbeats every 30 seconds, so a stale
> `last_seen_at` means the worker is down.
> **Evidence:** `run_job()` blocks the same loop that calls `announce()`, and a
> `propose_cleaning` turn outlasts the dashboard's 90-second threshold.
> **Correct:** the row went stale *because* the worker was busy.
> **Rule:** a liveness signal emitted only between units of work reports the
> opposite of the truth under load. Emit it from inside the work.

---

## Before you say it is done

- [ ] Root cause identified, not just the symptom
- [ ] Invariants named and checked
- [ ] Rollback point exists and is written down
- [ ] Baseline captured before the change
- [ ] Tests run, and named in the report
- [ ] A real job through the shipped worker, if behaviour changed
- [ ] `model_used` still populated for LLM-backed jobs
- [ ] Verified in the running deployment, not just the source tree
- [ ] Every claim labelled verified / measured / inferred / estimated / unverified
- [ ] Anything you did not check is listed as unverified
- [ ] For an auth failure: secret fingerprints compared per route, not per gateway
- [ ] For a "service down" claim: the port probed from the calling container,
      not the status label read from a CLI or dashboard
