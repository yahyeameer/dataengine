#!/usr/bin/env bash
#
# Audit: does every card's execution status agree with its business verdict?
#
# The failure this catches was observed, not imagined. On 2026-08-31 a verifier
# card correctly detected a corrupted figure, wrote {"verdict":"FAIL"} into its
# run metadata -- and then called kanban_complete. The card went to `done`. On
# the board it was indistinguishable from a verification that passed, and the
# only way to learn otherwise was to read the run metadata of a card nobody had
# a reason to open.
#
# The card-body protocol (integrations/hermes/kanban/verifier-card.md) tells a
# verifier to block on FAIL so the status carries the verdict. That is
# prevention, and prevention written in a prompt is advisory: the model already
# deviated from it once. This is the detection half.
#
# Read-only. Touches no task, writes nothing, and exits non-zero when a card
# claims success while carrying a non-PASS verdict.
#
# Usage:
#   scripts/kanban-verdict-audit.sh [board]        # default board: dataengine
#
# Runs over SSH against the agent container, because kanban.db lives inside it
# and nothing outside that container can read it.

set -euo pipefail

BOARD="${1:-dataengine}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/srv1927440}"
SSH_HOST="${SSH_HOST:-root@191.215.42.242}"
CONTAINER="${HERMES_CONTAINER:-hermes-agent-bwlq-hermes-agent-1}"

ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" \
  "BOARD='$BOARD' CONTAINER='$CONTAINER' bash -s" <<'REMOTE'
set -euo pipefail
K="/opt/hermes/.venv/bin/hermes kanban --board $BOARD"

ids=$(docker exec -u hermes "$CONTAINER" timeout 60 $K list --archived < /dev/null 2>/dev/null \
      | grep -oE 't_[0-9a-f]{8}' | sort -u)

if [ -z "$ids" ]; then
  echo "no cards on board '$BOARD'"
  exit 0
fi

fail=0
for id in $ids; do
  status=$(docker exec -u hermes "$CONTAINER" timeout 60 $K show "$id" --json < /dev/null 2>/dev/null \
           | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["status"])' 2>/dev/null || echo "?")

  # The verdict has two carriers, because the two terminal calls differ:
  #   kanban_complete -> run metadata {"verdict": ...}
  #   kanban_block    -> reason string only. kanban_block takes task_id,
  #                      reason and kind and has NO metadata parameter, so a
  #                      blocked verifier's structured detail lives in a
  #                      comment and the VERDICT=FAIL: prefix is the only
  #                      machine-readable half. Verified against the tool
  #                      schema on 2026-08-31.
  verdict=$(docker exec -u hermes "$CONTAINER" timeout 60 $K runs "$id" --json < /dev/null 2>/dev/null             | python3 -c '
import sys, json
runs = json.load(sys.stdin)
# The latest run is the one that decided the card. Earlier runs are history: a
# card that blocked, was unblocked and then passed is healthy, and judging it on
# its first attempt would report a fault that no longer exists.
md = (runs[-1].get("metadata") or {}) if runs else {}
print(md.get("verdict", ""))
' 2>/dev/null || echo "")

  if [ -z "$verdict" ]; then
    reason=$(docker exec -u hermes "$CONTAINER" timeout 60 $K show "$id" --json < /dev/null 2>/dev/null              | python3 -c '
import sys, json
d = json.load(sys.stdin)
blocked = [e for e in d.get("events", []) if e.get("kind") == "blocked"]
print(str((blocked[-1].get("payload") or {}).get("reason", "")) if blocked else "")
' 2>/dev/null || echo "")
    case "$reason" in
      VERDICT=FAIL:*) verdict="FAIL" ;;
      VERDICT=PASS:*) verdict="PASS" ;;
    esac
  fi

  # A card with no verdict on either carrier is not a verifier. Producer cards
  # (criteria, profile, report) legitimately have none, and flagging them would
  # make the audit cry wolf on every healthy chain -- which is how a check stops
  # being read.
  [ -z "$verdict" ] && continue

  # Archiving is an explicit human retirement and it overwrites the status, so
  # `archived` can no longer say whether the card passed or failed. Judging it
  # would flag every correctly-handled card somebody has since tidied away.
  # Reported, not failed: the audit is about whether the live board tells the
  # truth.
  if [ "$status" = "archived" ]; then
    echo "skipped  $id: verdict=$verdict status=archived (retired; status no longer carries the verdict)"
    continue
  fi

  if [ "$verdict" = "PASS" ] && [ "$status" != "done" ]; then
    echo "MISMATCH $id: verdict=PASS but status=$status"
    fail=1
  elif [ "$verdict" != "PASS" ] && [ "$status" = "done" ]; then
    echo "MISMATCH $id: verdict=$verdict but status=done (a failed check wearing a success badge)"
    fail=1
  elif [ "$verdict" != "PASS" ] && [ "$status" != "blocked" ]; then
    echo "MISMATCH $id: verdict=$verdict but status=$status (a FAIL must block)"
    fail=1
  else
    echo "ok       $id: verdict=$verdict status=$status"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAIL: at least one card's status contradicts its verdict."
  echo "See integrations/hermes/kanban/verifier-card.md for the protocol."
  exit 1
fi
echo
echo "PASS: every verifier card's status agrees with its verdict."
REMOTE
