/**
 * POST /api/store/install
 *
 * - free          → insert user_installed_plugins row, paid_until=null
 * - subscription  → require blockchain, create Coinpay invoice, return invoice details
 * - revshare      → insert active row, no paid_until (settled out-of-band)
 *
 * Rejects coming-soon entries; rejects duplicate active install (409).
 */
import type { NextRequest } from 'next/server';
import { PLUGIN_CATALOG } from '@b1dz/core';
import { authenticate, unauthorized } from '@/lib/api-auth';
import {
  coinpayConfigured,
  createInvoiceForPlugin,
  isSupportedBlockchain,
  SUPPORTED_BLOCKCHAINS,
} from '@/lib/coinpay-client';

export const dynamic = 'force-dynamic';

interface ExistingRow {
  plugin_id: string;
  status: string;
  paid_until: string | null;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null) as { pluginId?: unknown; blockchain?: unknown } | null;
  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
  if (!pluginId) return Response.json({ error: 'pluginId required' }, { status: 400 });

  const entry = PLUGIN_CATALOG.find((e) => e.manifest.id === pluginId);
  if (!entry) return Response.json({ error: `unknown plugin: ${pluginId}` }, { status: 404 });

  if (entry.status === 'coming-soon') {
    return Response.json({ error: 'plugin is not yet available' }, { status: 400 });
  }

  // Reject duplicate active install
  const c = auth.client as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (col: string, val: string) => {
          eq: (col2: string, val2: string) => {
            maybeSingle: () => Promise<{ data: ExistingRow | null; error: { message: string } | null }>;
          };
        };
      };
      insert: (r: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    };
  };
  const existing = await c.from('user_installed_plugins')
    .select('plugin_id, status, paid_until')
    .eq('user_id', auth.userId)
    .eq('plugin_id', pluginId)
    .maybeSingle();

  if (existing.error) return Response.json({ error: existing.error.message }, { status: 500 });
  if (existing.data && existing.data.status === 'active') {
    const stillPaid = !existing.data.paid_until || new Date(existing.data.paid_until).getTime() > Date.now();
    if (stillPaid) return Response.json({ error: 'plugin already installed' }, { status: 409 });
  }

  const pricing = entry.pricing;
  const version = entry.manifest.version;

  if (pricing.model === 'free' || pricing.model === 'revshare') {
    const insert = await c.from('user_installed_plugins').insert({
      user_id: auth.userId,
      plugin_id: pluginId,
      version,
      status: 'active',
      paid_until: null,
      installed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (insert.error) {
      // Treat duplicate-key as success-ish (idempotent install)
      if (/duplicate key/i.test(insert.error.message)) return Response.json({ installed: true });
      return Response.json({ error: insert.error.message }, { status: 500 });
    }
    return Response.json({ installed: true, model: pricing.model });
  }

  // subscription: needs Coinpay + blockchain
  if (!coinpayConfigured()) {
    return Response.json(
      { error: 'Coinpay payment processor not configured on this server', supportedBlockchains: SUPPORTED_BLOCKCHAINS },
      { status: 503 },
    );
  }
  if (!isSupportedBlockchain(body?.blockchain)) {
    return Response.json(
      { error: `blockchain required, must be one of: ${SUPPORTED_BLOCKCHAINS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const invoice = await createInvoiceForPlugin({
      userId: auth.userId,
      pluginId,
      amountUsd: pricing.usdPerMonth,
      blockchain: body!.blockchain as typeof SUPPORTED_BLOCKCHAINS[number],
      description: `${entry.manifest.name} — monthly subscription`,
      client: auth.client,
    });
    return Response.json({ invoice });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
