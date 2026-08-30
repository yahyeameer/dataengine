import Link from 'next/link';

import { AuthForm } from '@/components/auth-form';
import { ProductStory } from '@/components/product-story';

export const metadata = {
  title: 'DataEngine · Turn messy business data into decisions',
  description:
    'Upload a spreadsheet. DataEngine finds the real table inside it, proposes fixes you approve, and repeats the work next month with only the exceptions surfaced.',
};

/**
 * Sign-in, and the first thing anybody sees.
 *
 * Treated as the product's front door rather than a form: a visitor who has
 * been sent a link should understand what DataEngine does before deciding
 * whether to type an email into it.
 *
 * The composition is two columns that become one on a narrow screen, with the
 * form first in the DOM so a returning customer tabs straight into it rather
 * than through the marketing copy.
 */
export default function LoginPage() {
  return (
    <main className="relative flex min-h-svh flex-1 items-center overflow-hidden px-6 py-12">
      <Backdrop />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_minmax(360px,420px)] lg:gap-16">
        {/* Second on small screens, first on large: the story supports the
            decision, but it should not stand between a returning user and the
            field they came to fill in. */}
        <div className="order-2 lg:order-1">
          <ProductStory />
        </div>

        <div className="order-1 lg:order-2">
          <div className="glass rounded-[var(--radius-lg)] p-6 shadow-[var(--shadow-lg)] sm:p-7">
            <h2 className="text-lg font-semibold tracking-tight">Sign in</h2>
            <p className="mt-1 mb-5 text-sm text-muted">
              Continue to your workspace.
            </p>

            <AuthForm mode="login" />
          </div>

          <p className="mt-4 px-1 text-center text-xs leading-relaxed text-subtle">
            A copilot, not an autonomous accountant. Every material change is reviewed and signed
            off by a person, and every number can be traced to its source rows.
          </p>
        </div>
      </div>

      <footer className="absolute inset-x-0 bottom-0 px-6 py-4 text-center text-xs text-subtle">
        <Link className="transition-colors hover:text-muted" href="/signup">
          Create an account
        </Link>
      </footer>
    </main>
  );
}

/**
 * The backdrop.
 *
 * Two very soft accent washes and a hairline grid that fades out before it
 * reaches the content. It is doing one job — giving the glass panel something
 * to be glass against — and it is deliberately too quiet to notice on purpose.
 *
 * Pure CSS: no canvas, no particles, no animation loop running behind a login
 * form on someone's laptop battery.
 */
function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full opacity-[0.07]"
        style={{ background: 'radial-gradient(circle, var(--accent) 0%, transparent 70%)' }}
      />
      <div
        className="absolute -bottom-56 -right-32 h-[38rem] w-[38rem] rounded-full opacity-[0.05]"
        style={{ background: 'radial-gradient(circle, var(--info) 0%, transparent 70%)' }}
      />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 40%, black 20%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 60% at 50% 40%, black 20%, transparent 75%)',
        }}
      />
    </div>
  );
}
