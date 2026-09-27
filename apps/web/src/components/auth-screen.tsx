import type { ReactNode } from 'react';

import { ProductStory } from '@/components/product-story';
import { Card } from '@/components/ui';

/**
 * The frame both sign-in and sign-up sit in.
 *
 * It exists because they were the same forty lines twice, and a layout kept in
 * two places is a layout that drifts: the columns, the gap, the ordering and
 * the footnote all had to be changed identically or the two screens would stop
 * matching.
 *
 * The geometry is the part worth explaining, because the previous version
 * measured badly in a way that is easy to miss in code and obvious on screen.
 * It asked for `1.1fr` of a `max-w-6xl` container against a 420px card, which
 * resolved to a 652px track — while the content inside that track was capped at
 * `max-w-md`, or 448px. So 204px of the left column was empty by construction,
 * the gap *read* as 220px rather than the 80px it was set to, and the whole
 * composition sat off-centre with a hole down the middle.
 *
 * So the track is now the measure. The left column is 29rem because that is a
 * comfortable line length for the story at 15px, the card is 25rem, the gap is
 * the 5rem it says it is, and the container is exactly their sum — which means
 * the page is centred on its content rather than on a box that content does not
 * fill.
 *
 * `items-start` rather than `items-center`: the story is 981px tall and the
 * card is 384px, and centring a short thing against a long one left ~270px of
 * nothing above the form on every screen. Aligned to the top, the empty space
 * ends up below the fold where nobody is looking for anything.
 */
export function AuthScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-6 py-14">
      <div className="mx-auto grid w-full max-w-[59rem] items-start gap-14 lg:grid-cols-[minmax(0,29rem)_minmax(0,25rem)] lg:gap-20">
        {/* The form first on a phone: somebody returning to sign in should not
            have to scroll past the pitch to reach the thing they came for. */}
        <div className="order-2 lg:order-1">
          <ProductStory />
        </div>

        <div className="order-1 lg:order-2">
          <Card className="p-7">
            <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>
            <div className="mt-6">{children}</div>
          </Card>

          <p className="mt-4 px-1 text-center text-xs leading-relaxed text-subtle">
            A copilot, not an autonomous accountant. Every change is verified and signed off by a
            person.
          </p>
        </div>
      </div>
    </main>
  );
}
