import Link from 'next/link';
import { createAdminSupabase } from '@/lib/supabase';

interface InstalledRow {
  plugin_id: string;
  status: string;
  paid_until: string | null;
}

const WARN_DAYS = 7;

export async function RenewalBanner({ userId }: { userId: string }) {
  let expiring: InstalledRow[] = [];
  let expired: InstalledRow[] = [];

  try {
    const admin = createAdminSupabase() as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (c: string, v: string) => {
            not: (c: string, op: string, v: unknown) => Promise<{ data: InstalledRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
    const { data } = await admin.from('user_installed_plugins')
      .select('plugin_id, status, paid_until')
      .eq('user_id', userId)
      .not('paid_until', 'is', null);

    const now = Date.now();
    const warnMs = WARN_DAYS * 86_400_000;
    for (const row of (data ?? [])) {
      if (!row.paid_until) continue;
      const expiresMs = new Date(row.paid_until).getTime();
      if (expiresMs <= now) expired.push(row);
      else if (expiresMs - now < warnMs) expiring.push(row);
    }
  } catch {
    return null;
  }

  if (expiring.length === 0 && expired.length === 0) return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-300 flex items-center justify-between gap-4">
      <span>
        {expired.length > 0 && (
          <span className="mr-3 text-red-300">
            {expired.length} plugin{expired.length > 1 ? 's' : ''} expired.
          </span>
        )}
        {expiring.length > 0 && (
          <span>
            {expiring.length} plugin{expiring.length > 1 ? 's' : ''} expiring within {WARN_DAYS} days.
          </span>
        )}
      </span>
      <Link href="/store" className="underline hover:text-amber-200 whitespace-nowrap">Renew in Store →</Link>
    </div>
  );
}
