import { AuthForm } from '@/components/auth-form';
import { ProductStory } from '@/components/product-story';
import { Card } from '@/components/ui';

export const metadata = { title: 'Create account · DataEngine' };

/**
 * The same shape as sign-in, deliberately.
 *
 * This was a bare 24rem column with a heading and a card while `/login` was a
 * two-column pitch — so a reader who followed "Create account" from the sign-in
 * page arrived somewhere that looked like a different product. Whatever we are
 * willing to claim to someone signing in, we should be willing to claim to
 * someone signing up.
 */
export default function SignupPage() {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-6 py-14">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_minmax(360px,420px)] lg:gap-20">
        <div className="order-2 lg:order-1">
          <ProductStory />
        </div>

        <div className="order-1 lg:order-2">
          <Card className="p-7">
            <h1 className="text-[22px] font-semibold tracking-tight">Create your account</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              You will set up your firm on the next screen.
            </p>

            <div className="mt-6">
              <AuthForm mode="signup" />
            </div>
          </Card>

          <p className="mt-4 px-1 text-center text-xs leading-relaxed text-subtle">
            A copilot, not an autonomous accountant. Every change is verified and
            signed off by a person.
          </p>
        </div>
      </div>
    </main>
  );
}
