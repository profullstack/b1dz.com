import { brokerLinks } from '@/lib/referrals';

export const dynamic = 'force-dynamic';

/** GET /api/referrals — where "open an account" links for each broker and exchange go. Public. */
export function GET() {
  return Response.json({ brokers: brokerLinks() }, { headers: { 'cache-control': 'public, max-age=600' } });
}
