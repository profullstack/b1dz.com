import { redirect, notFound } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase';
import { InvoiceClient } from './invoice-client';

export const dynamic = 'force-dynamic';

interface InvoiceRow {
  id: string;
  user_id: string;
  plugin_id: string;
  coinpay_payment_id: string | null;
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

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/store/invoice/${id}`);

  const { data, error } = await supabase
    .from('plugin_invoices')
    .select('id, user_id, plugin_id, coinpay_payment_id, amount_usd, blockchain, payment_address, crypto_amount, qr_code, status, expires_at, paid_at, forwarded_at, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) notFound();
  const invoice = data as InvoiceRow;
  if (invoice.user_id !== user.id) redirect('/store');

  return <InvoiceClient initial={invoice} />;
}
