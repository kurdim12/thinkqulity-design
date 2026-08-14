import { Suspense } from 'react';
import { CallbackClient } from './CallbackClient';

export const dynamic = 'force-dynamic';

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackClient />
    </Suspense>
  );
}
