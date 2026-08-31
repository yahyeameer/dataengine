import { CategoriseFlow } from '@/components/categorise-flow';
import { requireCurrentOrg } from '@/lib/authz';

export const metadata = { title: 'Categorise · DataEngine' };

/**
 * The first screen after signing in, and deliberately the smallest one.
 *
 * It used to be a directory of workspaces — accurate, and an answer to a
 * question the accountant had not asked yet. What they came to do is get a file
 * categorised, so that is what is here, and the directory has moved one click
 * away to /app/workspaces where it is still complete and still the way in to a
 * run's full history.
 *
 * A server component that renders one client component and nothing else. There
 * is no data to fetch: the flow resolves its own workspace on the first upload,
 * and pre-fetching one here would only put a spinner in front of an empty
 * dropzone.
 */
export default async function CategorisePage() {
  // Not for the value — for the redirect. A user with no organisation belongs in
  // onboarding, and this is the route they will land on.
  await requireCurrentOrg();

  return (
    <div className="py-6 sm:py-12">
      <CategoriseFlow />
    </div>
  );
}
