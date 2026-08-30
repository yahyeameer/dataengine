import { AuthForm } from '@/components/auth-form';
import { Card } from '@/components/ui';

export const metadata = { title: 'Create account · DataEngine' };

export default function SignupPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mb-6 text-sm text-muted">You will set up your firm on the next screen.</p>
      <Card className="p-5">
        <AuthForm mode="signup" />
      </Card>
    </main>
  );
}
