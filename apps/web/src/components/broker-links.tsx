'use client';

import { useEffect, useState } from 'react';

interface BrokerLink {
  id: string;
  name: string;
  kind: 'stocks' | 'crypto';
  url: string;
  referral: boolean;
}

/** "No account yet? Open one at ..." links, referral when configured (lib/referrals.ts). */
export function BrokerLinks({ kind, className = '' }: { kind?: 'stocks' | 'crypto'; className?: string }) {
  const [links, setLinks] = useState<BrokerLink[]>([]);
  useEffect(() => {
    fetch('/api/referrals')
      .then((r) => (r.ok ? r.json() : { brokers: [] }))
      .then((b: { brokers?: BrokerLink[] }) => setLinks((b.brokers ?? []).filter((x) => !kind || x.kind === kind)), () => setLinks([]));
  }, [kind]);
  if (!links.length) return null;
  return (
    <p className={`text-xs text-zinc-500 ${className}`}>
      No account yet? Open one at{' '}
      {links.map((l, i) => (
        <span key={l.id}>
          {i > 0 && (i === links.length - 1 ? ' or ' : ', ')}
          <a href={l.url} target="_blank" rel={l.referral ? 'noopener sponsored' : 'noopener noreferrer'} className="underline hover:text-zinc-300">
            {l.name}
          </a>
        </span>
      ))}
      {links.some((l) => l.referral) ? ' (some are referral links)' : ''}.
    </p>
  );
}
