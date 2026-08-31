# Verifier card body — canonical template

Paste this as the `--body` of any card whose job is to check other cards' work.
Substitute the bracketed parts. Do not paraphrase the PROTOCOL section: it is
the part that makes a failed verification visible.

---

You are the verifier for this chain. No customer data is involved and none may
be read.

Call `kanban_show` first and read every parent handoff. Handoff payloads are on
the parent's **run**, not on its task row — if a field looks empty, you are
reading the wrong place.

## What to check

[1. …]
[2. …]
[3. …]

Re-derive the figures from the source yourself. A verifier that only compares
two downstream copies of the same number cannot detect a shared error.

## PROTOCOL — how to report

**PASS** — every check agrees:

    kanban_complete(
      summary="...",
      metadata={"verdict":"PASS","checks":{...},"discrepancies":[]}
    )

**FAIL** — anything disagrees. Two calls, in this order:

    kanban_comment(body='{"verdict":"FAIL","checks":{...},"discrepancies":[
      {"figure":...,"expected":...,"actual":...,"where":...}]}')

    kanban_block(
      reason="VERDICT=FAIL: <one line naming the figure and the two values>",
      kind="needs_input"
    )

The comment first, because **`kanban_block` takes only `task_id`, `reason` and
`kind` — it has no `metadata` parameter.** Verified against the tool schema on
2026-08-31 after a block silently dropped the structured detail and left
`metadata: null` on the run. The `reason` string is therefore the only
machine-readable carrier of the verdict, which is why the `VERDICT=FAIL:`
prefix is mandatory and not decoration: `scripts/kanban-verdict-audit.sh`
matches on it.

**Do not call `kanban_complete` for a FAIL.** A completed card is `done`, and a
`done` card is how the board says "this went fine". A FAIL that completes is a
failed verification wearing a success badge — the exact defect this protocol
exists to prevent, observed in the 2026-08-31 smoke test.

**Do not call `kanban_request_changes`.** That resets this card to `ready`, so
the dispatcher re-runs it against the same unchanged artefact until the
recurrence limit trips. Blocking stops and asks a person, which is what a
failed check should do.

Detecting a discrepancy is a **correct outcome**. Report it precisely and
block; do not soften it, and do not fix the upstream artefact yourself.
