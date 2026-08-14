import { hasEnv, allowedEmails } from '@/lib/env';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const missing: string[] = [];
  if (!hasEnv('NEXT_PUBLIC_SUPABASE_URL')) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!hasEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!hasEnv('SUPABASE_SERVICE_ROLE_KEY')) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (allowedEmails().length === 0) missing.push('ALLOWED_EMAILS');

  return <LoginForm missingEnv={missing} />;
}
