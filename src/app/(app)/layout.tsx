import { redirect } from 'next/navigation';
import { getOperator } from '@/lib/auth';
import { Shell } from '@/components/Shell';

/**
 * Everything under (app) is behind auth. Middleware bounces sessionless
 * requests; this layout additionally enforces the ALLOWED_EMAILS allowlist.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const operator = await getOperator();
  if (!operator) redirect('/login');
  return <Shell email={operator.email}>{children}</Shell>;
}
