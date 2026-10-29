import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCheckoutSessionBody, createCheckoutSession, PAYMENT_PROPERTY } from './coinpay-client';
import { handleCoinPayEvent, readCoinPayEvent, type InvoiceRow, type InvoiceStore } from './plugin-billing';

const USER = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';

function memoryStore(invoices: (InvoiceRow & { coinpay_payment_id?: string | null })[]) {
  const installs = new Map<string, { paid_until: string | null; version: string }>();
  const upserts: Record<string, unknown>[] = [];
  const store: InvoiceStore = {
    async findBySessionId(id) { return invoices.find((i) => i.metadata?.checkout_session_id === id) ?? null; },
    async findById(id) { return invoices.find((i) => i.id === id) ?? null; },
    async findByPaymentId(id) { return invoices.find((i) => i.coinpay_payment_id === id) ?? null; },
    async claimPaid(id, updates) {
      const inv = invoices.find((i) => i.id === id);
      if (!inv || inv.paid_at) return false;
      Object.assign(inv, updates);
      return true;
    },
    async update(id, updates) { Object.assign(invoices.find((i) => i.id === id)!, updates); },
    async getInstall(u, p) { return installs.get(`${u}:${p}`) ?? null; },
    async upsertInstall(row) {
      upserts.push(row);
      installs.set(`${row.user_id}:${row.plugin_id}`, { paid_until: row.paid_until as string, version: row.version as string });
    },
  };
  return { store, installs, upserts, invoices };
}

function sessionInvoice(): InvoiceRow & { coinpay_payment_id: string | null } {
  return {
    id: INVOICE, user_id: USER, plugin_id: 'arb-pro', paid_at: null, status: 'pending', coinpay_payment_id: null,
    metadata: { checkout_session_id: 'cs_abc123', checkout_url: 'https://coinpayportal.com/checkout/cs_abc123' },
  };
}

function nested(type: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'evt_pay1_1700000000',
    type,
    data: {
      payment_id: 'pay_1', status, amount: 9, amount_usd: 9,
      checkout_session_id: 'cs_abc123', customer_email: 'a@example.com', account_id: USER, property: 'b1dz.com',
      metadata: { invoice_id: INVOICE, user_id: USER, plugin_id: 'arb-pro' },
      ...extra,
    },
  };
}

describe('buildCheckoutSessionBody', () => {
  it('carries email, account, property, metadata and return urls', () => {
    const body = buildCheckoutSessionBody({
      invoiceId: INVOICE, userId: USER, email: 'a@example.com', pluginId: 'arb-pro',
      amountUsd: 9, description: 'b1dz: Arb Pro, monthly subscription', kind: 'install', siteUrl: 'https://b1dz.com/',
    });
    expect(body).toMatchObject({
      amount: 9, currency: 'USD', customer_email: 'a@example.com', account_id: USER, property: PAYMENT_PROPERTY,
      metadata: { invoice_id: INVOICE, user_id: USER, plugin_id: 'arb-pro', b1dz_kind: 'plugin_subscription', b1dz_action: 'install' },
      success_url: `https://b1dz.com/store/invoice/${INVOICE}?session={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://b1dz.com/store',
      expires_in_minutes: 60,
    });
    expect(PAYMENT_PROPERTY).toBe('b1dz.com');
    expect(body).not.toHaveProperty('blockchain');
  });
});

describe('createCheckoutSession', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.COINPAY_API_KEY = 'cp_live_test';
    process.env.COINPAY_BUSINESS_ID = 'biz';
    process.env.COINPAY_BASE_URL = 'https://coinpayportal.com/api';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('POSTs /checkout/sessions with the bearer key and returns id + url', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ success: true, id: 'cs_x', url: 'https://coinpayportal.com/checkout/cs_x', expires_at: '2030-01-01T00:00:00Z' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const out = await createCheckoutSession({ invoiceId: INVOICE, userId: USER, email: 'a@example.com', pluginId: 'p', amountUsd: 5, description: 'd', kind: 'renew' }, fake);
    expect(out).toEqual({ id: 'cs_x', url: 'https://coinpayportal.com/checkout/cs_x', expiresAt: '2030-01-01T00:00:00Z' });
    expect(seen!.url).toBe('https://coinpayportal.com/api/checkout/sessions');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer cp_live_test');
    const sent = JSON.parse(String(seen!.init.body));
    expect(sent).toMatchObject({ customer_email: 'a@example.com', account_id: USER, property: 'b1dz.com' });
  });

  it('refuses a session url on another origin', async () => {
    const fake = (async () => new Response(JSON.stringify({ id: 'cs_x', url: 'https://evil.example/checkout/cs_x' }), { status: 201 })) as unknown as typeof fetch;
    await expect(createCheckoutSession({ invoiceId: INVOICE, userId: USER, email: 'a@example.com', pluginId: 'p', amountUsd: 5, description: 'd', kind: 'install' }, fake)).rejects.toThrow(/foreign/);
  });

  it('surfaces the CoinPay error code', async () => {
    const fake = (async () => new Response(JSON.stringify({ success: false, code: 'MISSING_CUSTOMER_EMAIL', error: 'customer_email is required' }), { status: 400 })) as unknown as typeof fetch;
    await expect(createCheckoutSession({ invoiceId: INVOICE, userId: USER, email: '', pluginId: 'p', amountUsd: 5, description: 'd', kind: 'install' }, fake)).rejects.toThrow(/MISSING_CUSTOMER_EMAIL/);
  });
});

describe('readCoinPayEvent', () => {
  it('reads the nested shape, not the event id', () => {
    const ev = readCoinPayEvent(nested('payment.confirmed', 'confirmed'));
    expect(ev).toMatchObject({ type: 'payment.confirmed', status: 'confirmed', paymentId: 'pay_1', checkoutSessionId: 'cs_abc123', accountId: USER });
  });
  it('falls back to the flat shape', () => {
    const ev = readCoinPayEvent({ event: 'payment.confirmed', payment_id: 'pay_9', status: 'confirmed', metadata: { invoice_id: INVOICE } });
    expect(ev.paymentId).toBe('pay_9');
    expect(ev.metadata.invoice_id).toBe(INVOICE);
  });
});

describe('handleCoinPayEvent', () => {
  it('settles a session invoice by checkout_session_id and extends the install', async () => {
    const m = memoryStore([sessionInvoice()]);
    const now = new Date('2026-10-21T00:00:00Z');
    const r = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.confirmed', 'confirmed')), now);
    expect(r.settled).toBe(true);
    expect(m.invoices[0]).toMatchObject({ status: 'confirmed', coinpay_payment_id: 'pay_1' });
    expect(m.invoices[0].paid_at).toBeTruthy();
    expect(m.installs.get(`${USER}:arb-pro`)?.paid_until).toBe('2026-11-20T00:00:00.000Z');
  });

  it('settles by metadata.invoice_id when the session id is absent', async () => {
    const m = memoryStore([sessionInvoice()]);
    const r = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.confirmed', 'confirmed', { checkout_session_id: undefined })));
    expect(r.settled).toBe(true);
  });

  it('does not settle an invoice id that belongs to another account', async () => {
    const m = memoryStore([sessionInvoice()]);
    const r = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.confirmed', 'confirmed', { checkout_session_id: undefined, account_id: 'someone-else' })));
    expect(r).toMatchObject({ settled: false, reason: 'unknown payment' });
    expect(m.upserts).toHaveLength(0);
  });

  it('a replay, and forwarded after confirmed, never extend twice', async () => {
    const m = memoryStore([sessionInvoice()]);
    const ev = readCoinPayEvent(nested('payment.confirmed', 'confirmed'));
    await handleCoinPayEvent(m.store, ev);
    const again = await handleCoinPayEvent(m.store, ev);
    const fwd = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.forwarded', 'forwarded')));
    expect(again).toMatchObject({ settled: false, reason: 'already paid' });
    expect(fwd).toMatchObject({ settled: false, reason: 'already paid' });
    expect(m.upserts).toHaveLength(1);
    expect(m.invoices[0].status).toBe('forwarded');
  });

  it('forwarded alone settles', async () => {
    const m = memoryStore([sessionInvoice()]);
    const r = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.forwarded', 'forwarded')));
    expect(r.settled).toBe(true);
    expect(m.upserts).toHaveLength(1);
  });

  it('pending does nothing, and an expired attempt leaves a session invoice open', async () => {
    const m = memoryStore([sessionInvoice()]);
    expect((await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.pending', 'pending')))).settled).toBe(false);
    expect((await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.expired', 'expired')))).settled).toBe(false);
    expect(m.invoices[0].status).toBe('pending');
    expect(m.upserts).toHaveLength(0);
  });

  it('legacy invoices still settle by payment_id', async () => {
    const legacy = { id: 'inv-legacy', user_id: USER, plugin_id: 'arb-pro', paid_at: null, status: 'pending', metadata: { user_id: USER }, coinpay_payment_id: 'pay_old' };
    const m = memoryStore([legacy]);
    const ev = readCoinPayEvent({ id: 'evt_x', type: 'payment.confirmed', data: { payment_id: 'pay_old', status: 'confirmed', metadata: { user_id: USER } } });
    expect((await handleCoinPayEvent(m.store, ev)).settled).toBe(true);
  });

  it('an unknown session answers unknown payment', async () => {
    const m = memoryStore([]);
    const r = await handleCoinPayEvent(m.store, readCoinPayEvent(nested('payment.confirmed', 'confirmed', { checkout_session_id: 'cs_nope', payment_id: 'pay_nope', metadata: {} })));
    expect(r).toEqual({ settled: false, reason: 'unknown payment' });
  });
});
