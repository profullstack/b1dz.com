/**
 * POST /api/v1/logicsrc/webhook
 *
 * grant.delivered / grant.updated / grant.revoked from logicsrc. No session and
 * no CSRF: every delivery is Standard Webhooks signed with the secret of the
 * request it answers, checked over the raw body.
 */
import { keyGrants } from '@/lib/logicsrc-grants';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return keyGrants().webhookResponse(req);
}
