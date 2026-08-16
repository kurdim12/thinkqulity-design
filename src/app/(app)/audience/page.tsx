import { redirect } from 'next/navigation';
import { MOVED } from '@/lib/nav';

/**
 * /audience — the screen is gone; the URL is not.
 *
 * The Audience screen rendered the stored audience insight and the timing
 * heatmap. Neither reading disappears: the insight is going to Brand's audience
 * section and the comment corpus to Board's comment lens, and `/api/audience`
 * still runs the feature unchanged, so the chat can still dispatch to it.
 *
 * What died is the fifteenth place an operator had to remember. What survives
 * is every link to it — the dashboard's timing link, the chat's dispatch
 * target, any bookmark — because this stub resolves them instead of 404ing.
 *
 * The destination is read from MOVED rather than written here, so the map in
 * src/lib/nav.ts and this redirect cannot drift. A key that is not in the map
 * is a tsc error, not a redirect into nowhere.
 */
export default function AudienceMoved(): never {
  redirect(MOVED['/audience']);
}
