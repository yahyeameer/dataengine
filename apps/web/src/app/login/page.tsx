import { AuthForm } from '@/components/auth-form';
import { ProductStory } from '@/components/product-story';
import { Card } from '@/components/ui';

export const metadata = { title: 'Sign in · DataEngine' };

/**
 * Sign in.
 *
 * This was a client component that tracked the cursor to tilt the form card in
 * 3D, over two blurred colour blobs and a masked grid, with a "Secure Sign In"
 * badge and a sparkle. All of it shipped framer-motion to the one screen in the
 * product that is only ever passed through.
 *
 * The page an accountant lands on before handing over a client's books should
 * look like somewhere that keeps records, not somewhere that keeps your
 * attention. The claims on the left do the persuading; the form does the rest.
 * Nothing on this page needs the client any more except the form itself.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-6 py-14">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_minmax(360px,420px)] lg:gap-20">
        <div className="order-2 lg:order-1">
          <ProductStory />
        </div>

        <div className="order-1 lg:order-2">
          <Card className="p-7">
            <h1 className="text-[22px] font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Sign in to your firm&rsquo;s workspaces and audit trail.
            </p>

            <div className="mt-6">
              <AuthForm mode="login" />
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
