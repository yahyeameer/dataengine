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

      {/* "Create firm", not "Create organization". The field above it asks for
          a firm name, the screen around it is headed "Set up your firm", and
          the sign-up page promised a firm -- the button was the one control
          still speaking the database's word for it. */}
      <button className={`${buttonClass()} w-full`} type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create firm'}
      </button>
    </form>
  );
}
