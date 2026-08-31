'use client';

import { useActionState } from 'react';

import { createOrganization, type ActionState } from '@/app/actions';
import { ErrorText, Field, buttonClass, inputClass } from '@/components/ui';

const initialState: ActionState = { error: null };

export function CreateOrgForm() {
  const [state, formAction, pending] = useActionState(createOrganization, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Firm name"
        hint="The practice or business that owns the client workspaces."
      >
        <input className={inputClass} name="name" required minLength={2} maxLength={200} />
      </Field>

      <ErrorText>{state.error}</ErrorText>

      <button className={buttonClass()} type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create organization'}
      </button>
    </form>
  );
}
