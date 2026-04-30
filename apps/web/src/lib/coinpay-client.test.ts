import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyCoinPayWebhook } from './coinpay-client';

const SECRET = 'whsec_test_super_secret_value';
const PAYLOAD = '{"event":"payment.confirmed","data":{"payment_id":"pay_abc123","amount":50}}';

function makeSig(timestamp: number, body: string, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

describe('verifyCoinPayWebhook', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.COINPAY_WEBHOOK_SECRET;
    process.env.COINPAY_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.COINPAY_WEBHOOK_SECRET;
    else process.env.COINPAY_WEBHOOK_SECRET = originalSecret;
  });

  it('accepts a valid signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyCoinPayWebhook(PAYLOAD, makeSig(ts, PAYLOAD))).toBe(true);
  });

  it('rejects when webhook secret unset', () => {
    delete process.env.COINPAY_WEBHOOK_SECRET;
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyCoinPayWebhook(PAYLOAD, makeSig(ts, PAYLOAD, SECRET))).toBe(false);
  });

  it('rejects a bad signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyCoinPayWebhook(PAYLOAD, `t=${ts},v1=deadbeef`)).toBe(false);
  });

  it('rejects when timestamp is older than 300s', () => {
    const ts = Math.floor(Date.now() / 1000) - 301;
    expect(verifyCoinPayWebhook(PAYLOAD, makeSig(ts, PAYLOAD))).toBe(false);
  });

  it('rejects when payload was tampered', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = makeSig(ts, PAYLOAD);
    const tampered = PAYLOAD.replace('"amount":50', '"amount":1000000');
    expect(verifyCoinPayWebhook(tampered, sig)).toBe(false);
  });

  it('rejects malformed signature header', () => {
    expect(verifyCoinPayWebhook(PAYLOAD, '')).toBe(false);
    expect(verifyCoinPayWebhook(PAYLOAD, 'garbage')).toBe(false);
    expect(verifyCoinPayWebhook(PAYLOAD, null)).toBe(false);
  });

  it('rejects when secret mismatches signing key', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigWithWrongSecret = makeSig(ts, PAYLOAD, 'wrong_secret');
    expect(verifyCoinPayWebhook(PAYLOAD, sigWithWrongSecret)).toBe(false);
  });
});
