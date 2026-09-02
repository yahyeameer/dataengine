/**
 * The assistant's history, as data.
 *
 * Kept out of `components/conversation.tsx` on purpose. That module is
 * `'use client'`, and in Next 16 every export of a client module is a client
 * reference -- a server component importing one of these helpers from there
 * would typecheck and then throw at request time. These are plain functions
 * over plain rows, so they belong in a plain module both halves can read.
 *
 * --- what a category is here ------------------------------------------------
 * Every grouping below is computed from a column that exists. When the history
 * says two questions are duplicates it is because the text matches; when it
 * says a turn is from last week it is because `created_at` says so; when it
 * files a turn under a client it is because `workspace_id` points there.
 *
 * There is deliberately no topic classifier. Bucketing questions into
 * "Categorisation", "Figures" and "Approvals" by keyword would read as
 * knowledge and be a guess -- an answer about a category column filed under
 * Figures because the accountant wrote "total" in the question is worse than
 * no label, because the reader would trust it.
 */

export type Turn = {
  requestId: string;
  /** Which client's books this question was asked about. */
  workspaceId: string;
  question: string;
  answer: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  /** Set once the turn has been removed to the trash. Null while it is live. */
  deletedAt: string | null;
};

/** The workspaces a question can be asked about, for the switcher and labels. */
export type WorkspaceOption = {
  id: string;
  name: string;
  clientName: string | null;
};

// -----------------------------------------------------------------------------
// Duplicates
// -----------------------------------------------------------------------------

/**
 * The form two questions are compared in.
 *
 * Case, surrounding space, doubled spaces and a trailing question mark are all
 * things a person varies without meaning anything by it: "What changed?" and
 * "what changed" are the same question asked twice, and the usual reason there
 * are two is that the first one felt slow. Nothing else is normalised -- an
 * account number, a month or a threshold changing makes it a different
 * question, and a matcher clever enough to see past those would start merging
 * turns the reader can tell apart.
 */
export function questionSignature(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!\s]+$/, '');
}

export type DuplicateGroup = {
  /** The normalised question every turn in the group shares. */
  signature: string;
  /** The question as it was last written, for display. */
  question: string;
  workspaceId: string;
  /** Newest first. */
  turns: Turn[];
};

/**
 * Questions asked more than once about the same client.
 *
 * Scoped to the workspace, because "What changed in the latest version?" asked
 * about two different clients is two different questions with two different
 * answers. Groups of one are not duplicates and are not returned.
 */
export function duplicateGroups(turns: Turn[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();

  for (const turn of turns) {
    const signature = questionSignature(turn.question);
    if (!signature) continue;

    const key = `${turn.workspaceId} ${signature}`;
    const existing = groups.get(key);

    if (existing) {
      existing.turns.push(turn);
    } else {
      groups.set(key, {
        signature,
        question: turn.question,
        workspaceId: turn.workspaceId,
        turns: [turn],
      });
    }
  }

  return [...groups.values()]
    .filter((group) => group.turns.length > 1)
    .map((group) => ({
      ...group,
      turns: [...group.turns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }))
    .sort((a, b) => b.turns.length - a.turns.length);
}

/**
 * The turns a "remove the duplicates" action would actually remove.
 *
 * The newest of each group is kept, and it is the newest rather than the oldest
 * on purpose: when a question is asked twice the second attempt is the one that
 * was waited for, and it is at least as likely to have an answer. A turn that
 * is still `pending` is never proposed for removal -- deleting the row an open
 * subscription is watching leaves a spinner with nothing behind it.
 */
export function redundantTurns(turns: Turn[]): Turn[] {
  return duplicateGroups(turns).flatMap((group) =>
    group.turns.slice(1).filter((turn) => turn.status !== 'pending'),
  );
}

// -----------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------

export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'earlier';

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Earlier this week',
  month: 'This month',
  earlier: 'Earlier',
};

export const DATE_BUCKET_ORDER: DateBucket[] = ['today', 'yesterday', 'week', 'month', 'earlier'];

/**
 * Which bucket a timestamp falls in, measured in whole local days.
 *
 * Whole days rather than elapsed hours, because "yesterday" means the calendar
 * day before this one. Twenty-three hours ago at nine in the morning is
 * yesterday to a reader and "today" to a subtraction.
 */
export function dateBucket(timestamp: string, now: Date = new Date()): DateBucket {
  const then = new Date(timestamp);
  const days = Math.floor((startOfDay(now) - startOfDay(then)) / 86_400_000);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  if (days < 31) return 'month';
  return 'earlier';
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "14:32" today, "Mon" earlier this week, "12 Aug" beyond it. */
export function formatTurnTime(timestamp: string, now: Date = new Date()): string {
  const date = new Date(timestamp);
  const bucket = dateBucket(timestamp, now);

  if (bucket === 'today') {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (bucket === 'yesterday' || bucket === 'week') {
    return date.toLocaleDateString('en-GB', { weekday: 'short' });
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

export type TurnGroup = {
  key: string;
  label: string;
  /** Shown beside the label: how many turns are filed under it. */
  count: number;
  turns: Turn[];
};

export type Grouping = 'date' | 'client';

/**
 * The history, in sections.
 *
 * Two axes, because two questions get asked of a history and neither answer
 * serves the other. "What was I just doing" is a question about time; "what
 * have I asked about Hendricks" is a question about a client. Sorted by date
 * and read for a client, it means scanning every section.
 */
export function groupTurns(
  turns: Turn[],
  grouping: Grouping,
  workspaces: WorkspaceOption[],
  now: Date = new Date(),
): TurnGroup[] {
  const sorted = [...turns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (grouping === 'client') {
    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    const byWorkspace = new Map<string, Turn[]>();

    for (const turn of sorted) {
      const list = byWorkspace.get(turn.workspaceId);
      if (list) list.push(turn);
      else byWorkspace.set(turn.workspaceId, [turn]);
    }

    return [...byWorkspace.entries()]
      .map(([workspaceId, list]) => ({
        key: workspaceId,
        label: names.get(workspaceId) ?? 'Removed client',
        count: list.length,
        turns: list,
      }))
      // Most recently used client first, which is the one being worked on.
      .sort((a, b) => b.turns[0].createdAt.localeCompare(a.turns[0].createdAt));
  }

  const byBucket = new Map<DateBucket, Turn[]>();
  for (const turn of sorted) {
    const bucket = dateBucket(turn.createdAt, now);
    const list = byBucket.get(bucket);
    if (list) list.push(turn);
    else byBucket.set(bucket, [turn]);
  }

  return DATE_BUCKET_ORDER.filter((bucket) => byBucket.has(bucket)).map((bucket) => {
    const list = byBucket.get(bucket)!;
    return { key: bucket, label: DATE_BUCKET_LABELS[bucket], count: list.length, turns: list };
  });
}

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------

export type HistoryFilter = 'all' | 'answered' | 'unanswered' | 'duplicates' | 'trash';

export const FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  answered: 'Answered',
  unanswered: 'No answer',
  duplicates: 'Duplicates',
  trash: 'Trash',
};

export const FILTER_ORDER: HistoryFilter[] = [
  'all',
  'answered',
  'unanswered',
  'duplicates',
  'trash',
];

/**
 * The history a filter is asking for.
 *
 * `trash` is the only filter that reads removed rows, and every other one
 * excludes them -- removing a turn should take it out of every view except the
 * one whose whole purpose is to show what was removed.
 */
export function filterTurns(turns: Turn[], filter: HistoryFilter, search: string): Turn[] {
  const scope = turns.filter((turn) => (filter === 'trash' ? turn.deletedAt : !turn.deletedAt));

  let scoped = scope;

  if (filter === 'answered') {
    scoped = scope.filter((turn) => turn.status === 'done');
  } else if (filter === 'unanswered') {
    // Failed and still-thinking together: both are turns without an answer,
    // and the difference between them is a matter of minutes.
    scoped = scope.filter((turn) => turn.status !== 'done');
  } else if (filter === 'duplicates') {
    const inGroups = new Set(
      duplicateGroups(scope).flatMap((group) => group.turns.map((turn) => turn.requestId)),
    );
    scoped = scope.filter((turn) => inGroups.has(turn.requestId));
  }

  const needle = search.trim().toLowerCase();
  if (!needle) return scoped;

  // Answers are searched as well as questions. Half of what a person comes back
  // for is a figure they remember reading rather than a question they remember
  // typing.
  return scoped.filter(
    (turn) =>
      turn.question.toLowerCase().includes(needle) ||
      (turn.answer ?? '').toLowerCase().includes(needle),
  );
}

/** How many turns each filter would show, for the counts on the chips. */
export function filterCounts(turns: Turn[]): Record<HistoryFilter, number> {
  const live = turns.filter((turn) => !turn.deletedAt);

  return {
    all: live.length,
    answered: live.filter((turn) => turn.status === 'done').length,
    unanswered: live.filter((turn) => turn.status !== 'done').length,
    duplicates: duplicateGroups(live).reduce((total, group) => total + group.turns.length, 0),
    trash: turns.filter((turn) => turn.deletedAt).length,
  };
}

/** "Hendricks Ltd" or, when the client is named separately, both. */
export function workspaceLabel(workspace: WorkspaceOption): string {
  if (!workspace.clientName || workspace.clientName === workspace.name) return workspace.name;
  return `${workspace.name} - ${workspace.clientName}`;
}
