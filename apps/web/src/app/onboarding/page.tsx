import { redirect } from 'next/navigation';

import { CreateOrgForm } from '@/components/create-org-form';
import { Mark } from '@/components/product-story';
import { Card, ghostButtonClass } from '@/components/ui';
import { listMyOrganizations, requireUser } from '@/lib/authz';

export const metadata = { title: 'Set up your firm · DataEngine' };

/**
 * The screen `/signup` promises: "You will set up your firm on the next
 * screen."
 *
 * That promise led to a bare 24rem column with a heading and a card -- the
 * exact shape `/signup` itself was rescued from, one step further along the
 * same flow. A reader who had just been shown a two-column product page twice
 * arrived at a third screen that looked like a different, smaller application,
 * and it is the first screen they see as a customer rather than a visitor.
 *
 * So it takes the composition of the two screens before it, and not their
 * content. Sign-in and sign-up have a few seconds to say what the product is;
 * this reader has already decided. What they need is what the word "firm"
 * means here and what happens after they type one, which is what the left
 * column carries.
 */
const NEXT_STEPS = [
  {
    step: 'Name your firm',
    detail: 'The practice or business the client workspaces belong to.',
  },
  {
    step: 'Add your first client',
    detail: 'Each client gets a workspace. Data, recipes and the audit trail stay separate between them.',
  },
  {
    step: 'Upload their spreadsheet',
    detail: 'As the client sends it. DataEngine finds the real table inside it before anything else happens.',
  },
];

export default async function OnboardingPage() {
  const user = await requireUser();

  // Already onboarded: nothing to do here.
  const orgs = await listMyOrganizations();
  if (orgs.length > 0) redirect('/app');

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-6 py-14">
      <div className="mx-auto grid w-full max-w-5xl items-center gap-14 lg:grid-cols-[1fr_minmax(340px,400px)] lg:gap-20">
        <div className="order-2 lg:order-1">
          <div className="mb-8 flex items-center gap-2.5">
            <Mark />
            <span className="text-[15px] font-semibold tracking-tight">DataEngine</span>
          </div>

          <h1 className="max-w-md text-4xl font-semibold leading-[1.1] tracking-tight text-balance">
            One step, and the first file can go in.
          </h1>

          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            A firm is the top of the structure: it owns the workspaces, and a workspace holds one
            client&rsquo;s data. It is the name that sits above your workspace list, and it is only
            ever seen by the people you invite into the firm.
          </p>

          {/* The same numbered sequence as the sign-in page's pipeline, so the
              third screen of the flow is recognisably built by the same hand. */}
          <ol className="mt-10 max-w-md space-y-0">
            {NEXT_STEPS.map(({ step, detail }, i) => (
              <li key={step} className="relative flex gap-4 pb-5 last:pb-0">
                {i < NEXT_STEPS.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[11px] top-6 h-[calc(100%-1rem)] w-px bg-border"
                  />
                )}
                <span
                  aria-hidden
                  className="relative z-10 mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-soft font-mono text-[10px] font-semibold text-accent"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{step}</span>
                  <span className="block text-sm leading-relaxed text-subtle">{detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="order-1 lg:order-2">
          <Card className="p-7">
            <h2 className="text-[22px] font-semibold tracking-tight">Set up your firm</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              One field, and the only thing we need before your first client workspace.
            </p>

            <div className="mt-6">
              <CreateOrgForm />
            </div>
          </Card>

          {/* The one screen in the product that is behind sign-in and outside
              the shell, so it is also the one screen with no way back out.
              Somebody who signed in as the wrong account should not have to
              clear a cookie to fix it. */}
          <form action="/auth/signout" method="post" className="mt-4 flex items-center justify-center gap-2 px-1">
            <span className="truncate text-xs text-subtle" title={user.email ?? undefined}>
              Signed in as {user.email ?? 'this account'}
            </span>
            <button type="submit" className={`${ghostButtonClass()} shrink-0`}>
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
