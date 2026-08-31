'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { createWorkspace, type ActionState } from '@/app/actions';
import { ErrorText, Field, buttonClass, inputClass, secondaryButtonClass } from '@/components/ui';

const initialState: ActionState = { error: null };

export function CreateWorkspaceForm({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createWorkspace, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // The action revalidates the page on success, so a clean result means the
  // workspace is already in the list behind this form.
  useEffect(() => {
    if (!pending && state.error === null && formRef.current) {
      formRef.current.reset();
      setOpen(false);
    }
  }, [pending, state]);

  if (!open) {
    return (
      <button className={secondaryButtonClass()} onClick={() => setOpen(true)} type="button">
        New client workspace
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="w-full max-w-md space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15"
    >
      <input type="hidden" name="orgId" value={orgId} />

      <Field label="Workspace name" hint="How your team refers to this engagement.">
        <input className={inputClass} name="name" required minLength={2} maxLength={200} autoFocus />
      </Field>

      <Field label="Client name (optional)">
        <input className={inputClass} name="clientName" maxLength={200} />
      </Field>

      <ErrorText>{state.error}</ErrorText>

      <div className="flex gap-2">
        <button className={buttonClass()} type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create workspace'}
        </button>
        <button className={secondaryButtonClass()} type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
