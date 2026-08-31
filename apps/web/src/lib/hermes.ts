import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The contract with the Hermes Agent, in one place.
 *
 * Two directions cross this boundary and both are signed with the same shared
 * secret: the dashboard pushes a job out, and the agent reports back. Keeping
 * the signing in one module is not tidiness -- an outbound signer and an inbound
 * verifier that drift apart produce a 401 on every call and no clue why, because
 * a signature mismatch looks identical whatever caused it.
 *
 * What deliberately does *not* live here: any Supabase credential. The agent
 * holds none. It receives short-lived signed URLs for the one object it is meant
 * to read and the one it is meant to write, minted by the caller after
 * membership has already been checked. That is what keeps workspace isolation a
 * property of this application rather than a promise about the agent's
 * behaviour.
 */

/** Base url only -- the path is appended per route. */
const GATEWAY_URL = process.env.HERMES_WEBHOOK_URL;
const GATEWAY_SECRET = process.env.HERMES_WEBHOOK_SECRET;

/**
 * The secret for one gateway route.
 *
 * Hermes stores the HMAC secret **per route**, not per gateway: the adapter
 * resolves `route_config.get("secret", global_secret)` and every route created
 * through `hermes webhook subscribe` gets its own generated value. This client
 * had one `HERMES_WEBHOOK_SECRET` for every route, so it could only ever be
 * correct for one of them.
 *
 * It was correct for `dataengine-job`. `ask` had a different secret, so every
 * question an accountant asked came back
 * `401 {"error": "Invalid signature"}` — while job dispatch on the same
 * gateway, with the same code path and the same header, worked. That is why
 * the failure read as intermittent: it was not time-dependent, it was
 * route-dependent.
 *
 * Falls back to the shared secret, which is what a gateway configured with a
 * single global secret and no per-route override actually wants. So this is
 * additive: a deployment that has not set the per-route variables behaves
 * exactly as before.
 */
const ROUTE_SECRET_ENV: Record<string, string | undefined> = {
  ask: process.env.HERMES_ASK_SECRET,
  'dataengine-job': process.env.HERMES_JOB_SECRET,
};

export function secretForRoute(route: string): string {
  return ROUTE_SECRET_ENV[route] || GATEWAY_SECRET || '';
}

/**
 * The profile a gateway route is served by.
 *
 * With `gateway.multiplex_profiles` on, one gateway serves several profiles and
 * `/p/<profile>/webhooks/<route>` selects which. A route whose JSON carries no
 * `profile` key is bound to `default` and is reachable **only** at the
 * unprefixed path — the adapter's `_route_allows_profile` compares the route's
 * configured profile against the URL's and fails closed.
 *
 * Unset means the unprefixed path, which is the profile the routes are bound to
 * today. Setting it moves the call onto a profile's own URL, and the route's
 * JSON has to name the same profile or the gateway answers 404.
 */
const GATEWAY_PROFILE = process.env.HERMES_GATEWAY_PROFILE?.trim();

export function webhookUrlFor(route: string): string {
  const base = (GATEWAY_URL ?? '').replace(/\/$/, '');
  return GATEWAY_PROFILE
    ? `${base}/p/${GATEWAY_PROFILE}/webhooks/${route}`
    : `${base}/webhooks/${route}`;
}

/**
 * Which signing scheme the gateway verifies.
 *
 * `github` is the default because it is what this installation actually
 * documents: `hermes-webhook-integrations` specifies HMAC-SHA256 over the exact
 * raw request body, sent as `X-Hub-Signature-256: sha256=<hexdigest>` alongside
 * `X-GitHub-Event`. No timestamp participates in the digest.
 *
 * `v2` is kept for a gateway running the Generic Webhook V2 adapter instead.
 * The two are not interchangeable and a gateway expecting one rejects the other
 * with a 401 indistinguishable from a wrong secret, which is exactly why this
 * is a switch with a verified default rather than a guess at a convention.
 */
const SIGNING = (process.env.HERMES_WEBHOOK_SIGNING ?? 'github').toLowerCase();

/**
 * The gateway route jobs are pushed to.
 *
 * A Hermes subscription's name *is* its URL -- `hermes webhook subscribe
 * dataengine-job` creates `/webhooks/dataengine-job`, not a generic endpoint.
 * So this has to match the subscription's name exactly, and it is a variable
 * rather than a constant because the two live in different systems and a
 * mismatch is invisible until the first real job: the gateway answers 404, the
 * job is marked failed, and nothing says the name was the problem.
 */
const JOB_ROUTE = process.env.HERMES_JOB_ROUTE ?? 'dataengine-job';

/**
 * The worker id jobs are claimed under. Must match the row seeded by migration
 * 015, because `agent_jobs.claimed_by` is a foreign key into `agent_workers`.
 */
export const HERMES_WORKER_ID = process.env.HERMES_WORKER_ID ?? 'hermes-agent';

/**
 * How the agent reaches back. Inside Docker this is the web container's own
 * service name -- the callback never leaves the bridge network, so it needs no
 * certificate, and the HMAC is what authenticates it rather than the transport.
 */
const CALLBACK_BASE = process.env.DATAENGINE_CALLBACK_URL ?? 'http://web:3100';

/**
 * How long the agent has to use the URLs it is given.
 *
 * An hour, which is generous for a file capped at 50 MB. It is sized for the
 * deployment rather than the work: the agent shares one CPU core with a reverse
 * proxy, and a job that queues behind another job has not failed. Short enough
 * that a leaked url is worthless by the time anyone finds it.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** How long a claimed job is the agent's before another worker may take it. */
export const JOB_LEASE_SECONDS = 15 * 60;

/**
 * How stale an inbound callback's timestamp may be.
 *
 * Five minutes each way. Generous enough to survive clock drift between two
 * containers, tight enough that a captured callback cannot be replayed later to
 * mark somebody's failed job as succeeded.
 */
const CALLBACK_MAX_SKEW_SECONDS = 5 * 60;

export class HermesNotConfiguredError extends Error {
  constructor() {
    super(
      'The Hermes agent is not connected. Set HERMES_WEBHOOK_URL and ' +
        'HERMES_WEBHOOK_SECRET on the server.',
    );
    this.name = 'HermesNotConfiguredError';
  }
}

export function hermesConfigured(): boolean {
  return Boolean(GATEWAY_URL && GATEWAY_SECRET);
}

/**
 * The bytes a V2 signature covers, for the non-default scheme.
 *
 * Unverified against this installation -- `${timestamp}.${body}` is the common
 * convention rather than a standard, and a canonical string is a property of the
 * receiver. It is only reached when HERMES_WEBHOOK_SIGNING is set to `v2`, and
 * confirming it is a prerequisite of doing so. The default path below does not
 * use this function at all.
 */
export function canonicalV2(timestamp: string, payload: string): string {
  return `${timestamp}.${payload}`;
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Length-independent comparison, so a mismatch leaks no timing information. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Headers proving this server sent the request.
 *
 * The secret authenticates *the server*, never the person using it. It is never
 * sent to a browser, because a browser holding it could invoke the agent
 * directly, outside every membership check the route performs first.
 */
export function signingHeaders(
  payload: string,
  event: string,
  secret: string = GATEWAY_SECRET ?? '',
): Record<string, string> {
  if (SIGNING === 'github') {
    return {
      'X-Hub-Signature-256': `sha256=${hmacHex(secret, payload)}`,
      'X-GitHub-Event': event,
    };
  }

  // Seconds, not milliseconds. A receiver enforcing a replay window compares
  // this against a Unix timestamp, and one expressed in milliseconds reads as a
  // date tens of thousands of years out -- rejected as outside the window, with
  // the same 401 a bad signature produces.
  const timestamp = Math.floor(Date.now() / 1000).toString();

  return {
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature-V2': hmacHex(secret, canonicalV2(timestamp, payload)),
    'X-Webhook-Event': event,
  };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify a callback the agent sent us.
 *
 * Takes the raw body text rather than a parsed object on purpose: the signature
 * covers exact bytes, and `JSON.parse` followed by `JSON.stringify` can reorder
 * keys, drop whitespace and renormalise numbers. Re-serialising to verify would
 * fail on bodies that are perfectly valid.
 *
 * The reason strings are for the server log, never for the response. A caller
 * who cannot sign correctly gets 401 and nothing else -- telling them whether
 * the failure was the timestamp or the digest is telling them how to fix it.
 */
export function verifyCallbackSignature(
  rawBody: string,
  headers: Headers,
  secret: string = GATEWAY_SECRET ?? '',
): SignatureCheck {
  if (!secret) return { ok: false, reason: 'no shared secret configured' };

  if (SIGNING === 'github') {
    const sent = headers.get('x-hub-signature-256') ?? '';
    return safeEqual(sent, `sha256=${hmacHex(secret, rawBody)}`)
      ? { ok: true }
      : { ok: false, reason: 'signature mismatch' };
  }

  const timestamp = headers.get('x-webhook-timestamp') ?? '';
  const signature = headers.get('x-webhook-signature-v2') ?? '';

  if (!timestamp || !signature) return { ok: false, reason: 'missing signature headers' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'timestamp is not a number' };

  // Checked before the digest. A replayed body carries a valid signature by
  // definition, so the freshness window is the only thing standing between a
  // captured callback and a job being marked succeeded a second time.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - sent);
  if (skew > CALLBACK_MAX_SKEW_SECONDS) {
    return { ok: false, reason: `timestamp is ${skew}s away from now` };
  }

  return safeEqual(signature, hmacHex(secret, canonicalV2(timestamp, rawBody)))
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

/** Everything the agent needs to do one job, and nothing it does not. */
export type HermesJobPayload = {
  request_id: string;
  job_id: string;
  kind: string;
  workspace_id: string;
  dataset_id: string | null;
  dataset_version_id: string | null;
  input: {
    url: string;
    filename: string;
    byte_size: number | null;
  } | null;
  output: {
    export_url: string;
    export_path: string;
    format: string;
    parquet_url?: string;
    parquet_path?: string;
  } | null;
  callback_url: string;
  expires_at: string;
};

export function callbackUrl(): string {
  return `${CALLBACK_BASE.replace(/\/$/, '')}/api/hermes/jobs/result`;
}

export function newRequestId(): string {
  return randomUUID();
}

export type DispatchOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number | null; detail: string };

/**
 * POST a job to the agent's gateway.
 *
 * The gateway accepts and returns in milliseconds -- the answer never comes back
 * down this connection. An agent turn on a workbook was measured in minutes, and
 * nothing that blocked on it would survive a request timeout, so this call is
 * only ever asking "did you take it?".
 *
 * Never throws. A dispatch failure is an outcome the caller has to record on the
 * job row, not an exception to bubble into a 500 -- the job already exists at
 * this point, and leaving it queued with nothing coming for it is the one
 * ending that produces a spinner the customer watches forever.
 */
export async function dispatchJob(
  payload: HermesJobPayload,
  route: string = JOB_ROUTE,
): Promise<DispatchOutcome> {
  if (!GATEWAY_URL || !secretForRoute(route)) {
    return { ok: false, status: null, detail: 'Hermes is not configured on this server' };
  }

  // Serialised once. The signature covers these exact bytes, so re-serialising
  // for the request body would risk a different key order and an invalid
  // signature.
  const body = JSON.stringify(payload);

  try {
    const response = await fetch(webhookUrlFor(route), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signingHeaders(body, 'job.dispatched', secretForRoute(route)),
      },
      body,
      // Anything slower than this is the network, not the agent thinking.
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      return { ok: false, status: response.status, detail: detail || response.statusText };
    }

    return { ok: true, status: response.status };
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : 'unreachable';
    return { ok: false, status: null, detail };
  }
}
