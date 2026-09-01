'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';

import { createBrowserSupabase } from '@/lib/supabase/client';
import { ErrorText, Field, buttonClass, inputClass } from '@/components/ui';

/**
 * Email + password auth against Supabase, run from the browser so the session
 * cookie is established by the Supabase client itself and the proxy can then
 * refresh it on every subsequent request.
 */
export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isSignup = mode === 'signup';

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const supabase = createBrowserSupabase();

    const { error: authError } = isSignup
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError(authError.message);
      setPending(false);
      return;
    }

    // A brand-new user has no organization yet; /app sends them to onboarding.
    router.replace('/app');
    router.refresh();
  }

  return (
    // method="post" matters even though onSubmit handles the submission and
    // calls preventDefault. If the page has not hydrated -- a chunk fails to
    // load, JS is blocked, the network drops mid-load -- the browser falls back
    // to submitting natively, and an HTML form with no method defaults to GET.
    // That puts the password in the URL, and from there into browser history,
    // the referrer header and every access log along the way.
    <form onSubmit={onSubmit} method="post" className="space-y-4">
      <Field label="Work email">
        <input
          className={inputClass}
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field
        label="Password"
        hint={isSignup ? 'At least 6 characters.' : undefined}
      >
        <input
          className={inputClass}
          type="password"
          name="password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      <ErrorText>{error}</ErrorText>

      <button className={`${buttonClass()} w-full`} type="submit" disabled={pending}>
        {pending ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
      </button>

      <p className="text-center text-sm text-muted">
        {isSignup ? 'Already have an account? ' : 'No account yet? '}
        <Link
          className="font-medium text-accent transition-colors hover:text-accent-hover"
          href={isSignup ? '/login' : '/signup'}
        >
          {isSignup ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </form>
  );
}
