'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Invoice {
  id: string;
  plugin_id: string;
  amount_usd: string;
  blockchain: string;
  payment_address: string | null;
  crypto_amount: string | null;
  qr_code: string | null;
  status: string;
  expires_at: string | null;
  paid_at: string | null;
  forwarded_at: string | null;
  created_at: string;
}

const TERMINAL_OK = new Set(['confirmed', 'forwarded']);
const TERMINAL_ERR = new Set(['expired', 'failed']);

export function InvoiceClient({ initial }: { initial: Invoice }) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice>(initial);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (TERMINAL_OK.has(invoice.status) || TERMINAL_ERR.has(invoice.status)) return;
    const id = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/store/invoices/${invoice.id}`, { cache: 'no-store' });
        if (!r.ok) return;
        const body = await r.json() as { invoice?: Invoice };
        if (body.invoice) setInvoice(body.invoice);
      } catch { /* swallow polling errors */ }
    }, 5000);
    return () => window.clearInterval(id);
  }, [invoice.id, invoice.status]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (TERMINAL_OK.has(invoice.status)) {
      const t = window.setTimeout(() => router.push(`/store?installed=${invoice.plugin_id}`), 2500);
      return () => window.clearTimeout(t);
    }
  }, [invoice.status, invoice.plugin_id, router]);

  const expiresMs = invoice.expires_at ? new Date(invoice.expires_at).getTime() : null;
  const remainingSec = expiresMs ? Math.max(0, Math.floor((expiresMs - now) / 1000)) : null;

  const copyAddress = async () => {
    if (!invoice.payment_address) return;
    try {
      await navigator.clipboard.writeText(invoice.payment_address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between max-w-3xl mx-auto px-6 py-4 border-b border-zinc-800">
        <Link href="/store" className="text-sm text-zinc-400 hover:text-zinc-200">← Back to store</Link>
        <span className="text-xs text-zinc-500">Invoice {invoice.id.slice(0, 8)}…</span>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold mb-1">Pay {invoice.amount_usd} USD in {invoice.blockchain}</h1>
        <p className="text-sm text-zinc-400 mb-8">Plugin: <span className="font-mono text-orange-300">{invoice.plugin_id}</span></p>

        {TERMINAL_OK.has(invoice.status) ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
            <div className="text-emerald-300 text-3xl mb-2">✓</div>
            <h2 className="text-xl font-semibold text-emerald-200 mb-1">Payment received</h2>
            <p className="text-sm text-emerald-300/80">Plugin activated. Redirecting to store…</p>
          </div>
        ) : TERMINAL_ERR.has(invoice.status) ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
            <div className="text-red-300 text-3xl mb-2">✗</div>
            <h2 className="text-xl font-semibold text-red-200 mb-1">Payment {invoice.status}</h2>
            <p className="text-sm text-red-300/80 mb-4">No charge. You can try again from the store.</p>
            <Link href="/store" className="inline-block rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200 hover:bg-red-500/20 transition">Back to store</Link>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-6 mb-4">
              {invoice.qr_code ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={invoice.qr_code} alt="payment QR" className="mx-auto h-56 w-56 rounded bg-white p-2" />
              ) : (
                <div className="mx-auto h-56 w-56 flex items-center justify-center rounded bg-zinc-950 text-xs text-zinc-500">no QR available</div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-3 mb-4">
              <Field label="Send exactly" value={invoice.crypto_amount ? `${invoice.crypto_amount} ${invoice.blockchain}` : '—'} mono />
              <Field label="To address" value={invoice.payment_address ?? '—'} mono>
                {invoice.payment_address && (
                  <button onClick={copyAddress} className="text-xs text-orange-300 hover:text-orange-200">
                    {copied ? 'copied!' : 'copy'}
                  </button>
                )}
              </Field>
              <Field label="Status" value={
                <span className={
                  invoice.status === 'detected' ? 'text-amber-300' :
                  invoice.status === 'pending' ? 'text-zinc-300' : 'text-zinc-300'
                }>{invoice.status}</span>
              } />
              {remainingSec != null && (
                <Field label="Expires in" value={`${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`} />
              )}
            </div>

            <p className="text-xs text-zinc-500 text-center">
              This page polls every 5 seconds. You can close it — Coinpay will process the payment in the background once you broadcast the transaction.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Field({ label, value, mono, children }: { label: string; value: React.ReactNode; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs uppercase tracking-wider text-zinc-500 pt-0.5 whitespace-nowrap">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-sm text-zinc-100 ${mono ? 'font-mono break-all' : ''}`}>{value}</span>
        {children}
      </div>
    </div>
  );
}
