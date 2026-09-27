import { AuthForm } from '@/components/auth-form';
import { AuthScreen } from '@/components/auth-screen';

export const metadata = { title: 'Create account · DataEngine' };

export default function SignupPage() {
  return (
    <AuthScreen
      title="Create your account"
      subtitle="You will set up your firm on the next screen."
    >
      <AuthForm mode="signup" />
    </AuthScreen>
  );
}
