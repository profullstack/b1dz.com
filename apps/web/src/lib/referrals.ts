/**
 * Broker and exchange "open an account" links (plan item B: referral revenue
 * only as zero-maintenance links). A referral URL comes from
 * BROKER_REFERRAL_URLS (JSON object, broker id -> url, in app.env) or
 * data/broker-referrals.json; with neither, the plain signup link is shown.
 * Only https URLs are used.
 */
import file from '@/data/broker-referrals.json';

export interface BrokerLink {
  id: string;
  name: string;
  kind: 'stocks' | 'crypto';
  url: string;
  referral: boolean;
}

const httpsOnly = (u: unknown): string | null => {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export function brokerLinks(envJson: string | undefined = (process.env as Record<string, string | undefined>)['BROKER_REFERRAL_URLS']): BrokerLink[] {
  let overrides: Record<string, unknown> = {};
  try {
    const o = envJson ? JSON.parse(envJson) : {};
    if (o && typeof o === 'object' && !Array.isArray(o)) overrides = o as Record<string, unknown>;
  } catch {
    /* a bad env value means no overrides */
  }
  return (file.brokers as { id: string; name: string; kind: string; url: string; referral: string }[]).map((b) => {
    const ref = httpsOnly(overrides[b.id]) ?? httpsOnly(b.referral);
    return { id: b.id, name: b.name, kind: b.kind === 'stocks' ? 'stocks' : 'crypto', url: ref ?? b.url, referral: !!ref };
  });
}
