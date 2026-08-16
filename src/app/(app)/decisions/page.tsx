import { redirect } from 'next/navigation';
import { MOVED } from '@/lib/nav';

/**
 * /decisions — the ledger merges into the Strategist; the URL follows it.
 *
 * The ledger itself is untouched: `/api/decisions` still serves the whole
 * memory and still records a verdict, and the strategist run still writes
 * decisions and still refuses to judge one it has no data for. Only the
 * separate screen goes — a decision was always read next to the digest it
 * belongs to, and asking the operator to hold two screens in his head to see
 * one accountability loop was the sprawl this release is cutting.
 *
 * The destination is read from MOVED so the map in src/lib/nav.ts and this
 * redirect cannot drift.
 */
export default function DecisionsMoved(): never {
  redirect(MOVED['/decisions']);
}
