/**
 * POST /api/store/renew
 * Body: { pluginId }
 * Opens a fresh CoinPay checkout session for an existing subscription. The
 * webhook handler extends paid_until on confirmation.
 */
import type { NextRequest } from 'next/server';
import { PLUGIN_CATALOG } from '@b1dz/core';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { coinpayConfigured, createCheckoutForPlugin } from '@/lib/coinpay-client';

export const dynamic = 'force-dynamic';

interface ExistingRow {
  plugin_id: string;
  status: string;
  paid_until: string | null;
  version: string;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null) as { pluginId?: unknown } | null;
  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
  if (!pluginId) return Response.json({ error: 'pluginId required' }, { status: 400 });

  const entry = PLUGIN_CATALOG.find((e) => e.manifest.id === pluginId);
  if (!entry) return Response.json({ error: `unknown plugin: ${pluginId}` }, { status: 404 });

  if (entry.pricing.model !== 'subscription') {
    return Response.json({ error: 'no renewal needed for non-subscription plugins' }, { status: 400 });
  }

  // Confirm existing install row.
  const c = auth.client as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (col: string, val: string) => {
          eq: (col2: string, val2: string) => {
            maybeSingle: () => Promise<{ data: ExistingRow | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  const existing = await c.from('user_installed_plugins')
    .select('plugin_id, status, paid_until, version')
    .eq('user_id', auth.userId)
    .eq('plugin_id', pluginId)
    .maybeSingle();
  if (existing.error) return Response.json({ error: existing.error.message }, { status: 500 });
  if (!existing.data) return Response.json({ error: 'plugin not installed; use /api/store/install first' }, { status: 404 });

  if (!coinpayConfigured()) {
    return Response.json({ error: 'Coinpay payment processor not configured on this server' }, { status: 503 });
  }
  if (!auth.email) {
    return Response.json({ error: 'your account needs an email address to check out' }, { status: 400 });
  }

  try {
    const invoice = await createCheckoutForPlugin({
      userId: auth.userId,
      email: auth.email,
      pluginId,
      amountUsd: entry.pricing.usdPerMonth,
      description: `b1dz: ${entry.manifest.name}, renewal`,
      kind: 'renew',
      client: auth.client,
    });
    return Response.json({ invoice });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
