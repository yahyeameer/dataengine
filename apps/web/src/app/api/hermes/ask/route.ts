import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { secretForRoute, signingHeaders, webhookUrlFor } from '@/lib/hermes';
import { adminFor, requireWorkspaceAccess } from '@/lib/authz';

/**
 * Asking the Hermes agent a question.
 *
 * The agent runs on a VPS with Claude, the workspace's skills, and its own
 * Supabase connection. Its gateway is a webhook: a POST returns
 * `{"status":"accepted"}` in milliseconds and the answer never comes back down
 * that connection. So this route does not wait for one. It records the question,
 * fires the webhook, and returns a request id; the agent writes its reply into
 * `hermes_answers`, and the browser watches that row over Realtime.
 *
 * That shape is not a workaround, it is the only correct one here. An agent turn
 * measured 45 seconds on a categorisation and 226 seconds on a clarification,
 * and a Vercel function is killed at 60. Anything that blocked would be a
 * timeout waiting to happen.
 *
 * Two things this route exists to enforce, neither of which the agent can do
 * for itself:
 *
 * **The workspace is proven, not claimed.** `requireWorkspaceAccess` runs before
 * anything is recorded or sent, so a caller can only ask about a workspace the
 * database agrees they belong to.
 *
 * **The secret stays here.** The agent's webhook secret authenticates *this
 * server*, not the person using it. It is never sent to a browser, because a
 * browser holding it could invoke the agent directly, outside every check
 * above.
 *
 * What this route cannot enforce, and nobody should assume it does: the agent's
 * own database connection is account-level and RLS-exempt. The workspace id
 * travels into its prompt as an instruction. That is defence in depth, not
 * tenant isolation -- see the note in migration 014.
 */

const askSchema = z.object({
  workspaceId: z.string().uuid(),
  question: z.string().min(1).max(4000),
});

/**
 * Signing, the gateway address and the shared secret all live in lib/hermes.ts
 * now, because the job dispatch and the result callback use the same contract
 * and a signer that drifts from its verifier fails identically to a bad secret.
 */
const GATEWAY_URL = process.env.HERMES_WEBHOOK_URL;

/** The gateway route questions are pushed to. */
const ASK_ROUTE = 'ask';

/**
 * The `ask` route's own HMAC secret.
 *
 * Hermes keys the secret to the route, not to the gateway. This route used to
 * sign with the shared `HERMES_WEBHOOK_SECRET`, which is the *job* route's
 * secret on this installation -- so every question returned
 * `401 {"error": "Invalid signature"}` while job dispatch through the same
 * gateway succeeded. Resolved through `secretForRoute` so the two can never
 * drift apart again.
 */
const GATEWAY_SECRET = secretForRoute(ASK_ROUTE);

/** The event name the gateway route was subscribed to. */
const EVENT = 'question.asked';

export async function POST(request: Request) {
  try {
    const body = askSchema.parse(await request.json());

    // Membership first: nothing is recorded, and no webhook is fired, for a
    // workspace the caller cannot prove they belong to.
    const context = await requireWorkspaceAccess(body.workspaceId);

    if (!GATEWAY_URL || !GATEWAY_SECRET) {
      return NextResponse.json(
        {
          error:
            'The Hermes agent is not connected yet. Set HERMES_WEBHOOK_URL and ' +
            'HERMES_WEBHOOK_SECRET on the server.',
        },
        { status: 503 },
      );
    }

    const requestId = randomUUID();
    const admin = adminFor(context);

    // Recorded before the webhook fires. If the POST fails we still have a row
    // to mark failed; if it succeeds, the agent's update has something to land
    // on and cannot arrive before the row exists.
    const { error: insertError } = await admin.from('hermes_answers').insert({
      request_id: requestId,
      workspace_id: context.workspaceId,
      asked_by: context.user.id,
      question: body.question,
    });

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // The signature covers the exact bytes sent, so the body is serialised once
    // and that same string is both signed and posted. Re-serialising for the
    // request would risk a different key order and an invalid signature.
    const payload = JSON.stringify({
      request_id: requestId,
      workspace_id: context.workspaceId,
      question: body.question,
    });

    try {
      const response = await fetch(webhookUrlFor(ASK_ROUTE), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signingHeaders(payload, EVENT, GATEWAY_SECRET),
        },
        body: payload,
        // The gateway accepts and returns immediately; anything slower than
        // this is the network, not the agent thinking.
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        await admin
          .from('hermes_answers')
          .update({
            status: 'failed',
            error: `gateway returned ${response.status}: ${detail}`,
            answered_at: new Date().toISOString(),
          })
          .eq('request_id', requestId);

        return NextResponse.json(
          { error: `The agent's gateway refused the request (${response.status}).` },
          { status: 502 },
        );
      }
    } catch (caught) {
      // Unreachable gateway. Marked failed rather than left pending, because a
      // row that never resolves is a spinner the user watches forever.
      const message = caught instanceof Error ? caught.message : 'unreachable';
      await admin
        .from('hermes_answers')
        .update({
          status: 'failed',
          error: `could not reach the gateway: ${message}`.slice(0, 300),
          answered_at: new Date().toISOString(),
        })
        .eq('request_id', requestId);

      return NextResponse.json(
        { error: 'The agent could not be reached. It may be offline.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ requestId, status: 'accepted' }, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
