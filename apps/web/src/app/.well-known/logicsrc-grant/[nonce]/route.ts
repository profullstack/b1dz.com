/**
 * GET /.well-known/logicsrc-grant/<nonce>
 *
 * The grant manifest logicsrc fetches over TLS: which keys b1dz asks for, the
 * person's vault inbox key they are sealed to, and the webhook to deliver to.
 * Public by design; an unknown or expired nonce is a 404.
 */
import { keyGrants } from '@/lib/logicsrc-grants';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ nonce: string }> }) {
  const { nonce } = await params;
  return keyGrants().manifestResponse(nonce);
}
