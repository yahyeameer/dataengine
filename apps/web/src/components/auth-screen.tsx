import type { ReactNode } from 'react';

import { ProductStory } from '@/components/product-story';

/**
 * The frame both sign-in and sign-up sit in.
 *
 * It exists because they were the same forty lines twice, and a layout kept in
 * two places is a layout that drifts.
 *
 * **This is the one screen in the product that is meant to be looked at.**
 * Everywhere else somebody is working — reading a figure, approving a change,
 * checking a total — and the interface's job is to get out of the way. Here
 * nobody is working yet: they are deciding whether to hand this thing a
 * client's books, and there is nothing else on screen to compete with. So this
 * is where the glass, the ambient light and the depth live, and it is the only
 * place they do. `.liquid` in globals.css says the same thing from the other
 * side.
 *
 * The geometry underneath is unchanged and was measured rather than guessed:
 * a 29rem story column, a 25rem card, the 5rem gap it says it is, and a
 * container that is exactly their sum — so the page is centred on its content
 * rather than on a box the content does not fill. `items-start` because the
 * story is 960px tall against a 384px card, and centring a short thing against
 * a long one puts a quarter of a screen of nothing above the form.
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
    <>
      {/* Behind everything, fixed, and the only decoration in the product. The
          glass needs something to bend or it is just a darker box. */}
      <div className="ambient" aria-hidden>
        <span />
      </div>

      <main className="flex min-h-svh flex-1 items-center justify-center px-6 py-14">
        <div className="mx-auto grid w-full max-w-[59rem] items-start gap-14 lg:grid-cols-[minmax(0,29rem)_minmax(0,25rem)] lg:gap-20">
          {/* The form first on a phone: somebody returning to sign in should
              not have to scroll past the pitch to reach what they came for. */}
          <div className="order-2 lg:order-1">
            <ProductStory />
          </div>

          <div className="order-1 lg:order-2">
            <div className="liquid rounded-[var(--radius-xl)] p-7">
              <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>
              <div className="mt-6">{children}</div>
            </div>

            <p className="mt-4 px-1 text-center text-xs leading-relaxed text-subtle">
              A copilot, not an autonomous accountant. Every change is verified and signed off by
              a person.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
