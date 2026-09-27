import { AuthForm } from '@/components/auth-form';
import { AuthScreen } from '@/components/auth-screen';

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
    <AuthScreen title="Welcome back" subtitle="Sign in to your firm’s workspaces and audit trail.">
      <AuthForm mode="login" />
    </AuthScreen>
  );
}
