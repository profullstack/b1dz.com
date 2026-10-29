/**
 * Plugin subscription settlement: turns a CoinPay webhook (or a session the
 * invoice poller found paid) into a paid invoice + an extended install.
 *
 * Kept behind a small store interface so the webhook logic is testable without
 * Supabase. Settlement is idempotent: the invoice's paid_at is claimed with a
 * conditional update (only while it is still null), so a replayed event, or
 * payment.forwarded following payment.confirmed, never extends twice.
 */

export const SUBSCRIPTION_DAYS = 30;

export interface InvoiceRow {
  id: string;
  user_id: string;
  plugin_id: string;
  paid_at: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface InvoiceStore {
  findBySessionId(sessionId: string): Promise<InvoiceRow | null>;
  findById(id: string): Promise<InvoiceRow | null>;
  findByPaymentId(paymentId: string): Promise<InvoiceRow | null>;
  /** Set paid_at + updates only while paid_at is null. True when this call claimed it. */
  claimPaid(invoiceId: string, updates: Record<string, unknown>): Promise<boolean>;
  update(invoiceId: string, updates: Record<string, unknown>): Promise<void>;
  getInstall(userId: string, pluginId: string): Promise<{ paid_until: string | null; version: string } | null>;
  upsertInstall(row: Record<string, unknown>): Promise<void>;
}

export interface CoinPayEvent {
  type: string;
  status: string;
  paymentId: string | null;
  checkoutSessionId: string | null;
  accountId: string | null;
  metadata: Record<string, unknown>;
}

const SETTLED_STATUSES = new Set(['confirmed', 'forwarded']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** CoinPay nests the payment under `data`; the top-level `id` is the EVENT id. Flat is the fallback. */
export function readCoinPayEvent(payload: unknown): CoinPayEvent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const nested = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : null;
  const d = nested ?? p;
  const payment = d.payment && typeof d.payment === 'object' ? (d.payment as Record<string, unknown>) : null;
  const metadata = ((d.metadata ?? payment?.metadata ?? p.metadata ?? {}) as Record<string, unknown>) || {};
  const type = String(p.type ?? p.event ?? '');
  const status = String(d.status ?? payment?.status ?? (type.startsWith('payment.') ? type.slice(8) : '')).toLowerCase();
  return {
    type,
    status,
    paymentId: str(d.payment_id) ?? str(payment?.id) ?? (nested ? null : str(p.payment_id)),
    checkoutSessionId: str(d.checkout_session_id) ?? str(metadata.checkout_session_id),
    accountId: str(d.account_id) ?? str(metadata.account_id),
    metadata,
  };
}

export function isSettled(ev: CoinPayEvent): boolean {
  return ev.type === 'payment.confirmed' || ev.type === 'payment.forwarded' || SETTLED_STATUSES.has(ev.status);
}

function isSessionInvoice(inv: InvoiceRow): boolean {
  return !!str(inv.metadata?.checkout_session_id);
}

/** Session first, then our own invoice id in metadata (checked against the account), then the legacy payment id. */
export async function findInvoice(store: InvoiceStore, ev: CoinPayEvent): Promise<InvoiceRow | null> {
  if (ev.checkoutSessionId) {
    const bySession = await store.findBySessionId(ev.checkoutSessionId);
    if (bySession) return bySession;
  }
  const invoiceId = str(ev.metadata.invoice_id);
  if (invoiceId) {
    const byId = await store.findById(invoiceId);
    const owner = ev.accountId ?? str(ev.metadata.user_id);
    if (byId && (!owner || owner === byId.user_id)) return byId;
  }
  if (ev.paymentId) return store.findByPaymentId(ev.paymentId);
  return null;
}

export interface SettleResult {
  settled: boolean;
  reason: string;
  invoiceId?: string;
  paidUntil?: string;
}

/** Mark an invoice paid and extend the install by one period. Idempotent. */
export async function settleInvoice(
  store: InvoiceStore,
  invoice: InvoiceRow,
  opts: { paymentId: string | null; forwarded: boolean; now?: Date },
): Promise<SettleResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const updates: Record<string, unknown> = {
    status: opts.forwarded ? 'forwarded' : 'confirmed',
    paid_at: nowIso,
    updated_at: nowIso,
  };
  if (opts.forwarded) updates.forwarded_at = nowIso;
  if (opts.paymentId) updates.coinpay_payment_id = opts.paymentId;

  const claimed = await store.claimPaid(invoice.id, updates);
  if (!claimed) {
    // Already paid: only record the forward, never extend again.
    if (opts.forwarded) await store.update(invoice.id, { status: 'forwarded', forwarded_at: nowIso, updated_at: nowIso });
    return { settled: false, reason: 'already paid', invoiceId: invoice.id };
  }

  const existing = await store.getInstall(invoice.user_id, invoice.plugin_id);
  const currentMs = existing?.paid_until ? new Date(existing.paid_until).getTime() : 0;
  const baseMs = currentMs > now.getTime() ? currentMs : now.getTime();
  const paidUntil = new Date(baseMs + SUBSCRIPTION_DAYS * 86_400_000).toISOString();
  await store.upsertInstall({
    user_id: invoice.user_id,
    plugin_id: invoice.plugin_id,
    version: existing?.version ?? '0.0.0',
    status: 'active',
    paid_until: paidUntil,
    updated_at: nowIso,
  });
  return { settled: true, reason: 'paid', invoiceId: invoice.id, paidUntil };
}

/** Webhook entry point. Never throws for an unknown payment; the route answers 200 either way. */
export async function handleCoinPayEvent(store: InvoiceStore, ev: CoinPayEvent, now: Date = new Date()): Promise<SettleResult> {
  const invoice = await findInvoice(store, ev);
  if (!invoice) return { settled: false, reason: 'unknown payment' };

  if (isSettled(ev)) {
    const forwarded = ev.type === 'payment.forwarded' || ev.status === 'forwarded';
    return settleInvoice(store, invoice, { paymentId: ev.paymentId, forwarded, now });
  }

  const failed = ev.type === 'payment.expired' || ev.type === 'payment.failed' || ev.status === 'expired' || ev.status === 'failed';
  // A session outlives one attempt: the buyer can pick another coin after a
  // payment expires, so only legacy (single payment) invoices are failed here.
  if (failed && !invoice.paid_at && !isSessionInvoice(invoice)) {
    await store.update(invoice.id, { status: ev.status === 'failed' || ev.type === 'payment.failed' ? 'failed' : 'expired', updated_at: now.toISOString() });
    return { settled: false, reason: `status ${ev.status || ev.type}`, invoiceId: invoice.id };
  }
  return { settled: false, reason: `status ${ev.status || ev.type || 'unknown'}`, invoiceId: invoice.id };
}

type Q = {
  select: (s: string) => Q;
  eq: (c: string, v: string) => Q;
  is: (c: string, v: null) => Q;
  update: (r: Record<string, unknown>) => Q;
  upsert: (r: Record<string, unknown>, o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  limit: (n: number) => Q;
  then: Promise<{ data: unknown; error: { message: string } | null }>['then'];
};

const INVOICE_COLS = 'id, user_id, plugin_id, paid_at, status, metadata';

/** The Supabase (service-role) implementation of InvoiceStore. */
export function supabaseInvoiceStore(admin: unknown): InvoiceStore {
  const db = admin as { from: (t: string) => Q };
  const one = async (col: string, val: string): Promise<InvoiceRow | null> => {
    const { data, error } = await db.from('plugin_invoices').select(INVOICE_COLS).eq(col, val).limit(1).maybeSingle();
    if (error) throw new Error(`invoice lookup: ${error.message}`);
    return (data as InvoiceRow | null) ?? null;
  };
  return {
    findBySessionId: (id) => one('metadata->>checkout_session_id', id),
    findById: async (id) => (/^[0-9a-f-]{36}$/i.test(id) ? one('id', id) : null),
    findByPaymentId: (id) => one('coinpay_payment_id', id),
    async claimPaid(invoiceId, updates) {
      const { data, error } = await db.from('plugin_invoices').update(updates).eq('id', invoiceId).is('paid_at', null).select('id');
      if (error) throw new Error(`invoice claim: ${error.message}`);
      return Array.isArray(data) && data.length > 0;
    },
    async update(invoiceId, updates) {
      const { error } = await db.from('plugin_invoices').update(updates).eq('id', invoiceId);
      if (error) throw new Error(`invoice update: ${error.message}`);
    },
    async getInstall(userId, pluginId) {
      const { data, error } = await db.from('user_installed_plugins').select('paid_until, version').eq('user_id', userId).eq('plugin_id', pluginId).maybeSingle();
      if (error) throw new Error(`install lookup: ${error.message}`);
      return (data as { paid_until: string | null; version: string } | null) ?? null;
    },
    async upsertInstall(row) {
      const { error } = await db.from('user_installed_plugins').upsert(row, { onConflict: 'user_id,plugin_id' });
      if (error) throw new Error(`install upsert: ${error.message}`);
    },
  };
}
