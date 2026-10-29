/**
 * Sign in with CoinPay: first on /login and /signup. One CoinPay account signs
 * in across every Profullstack site; it binds to the CoinPay account itself,
 * never to an email address.
 */
export function CoinpaySigninButton({ next }: { next?: string }) {
  const href = `/api/v1/coinpay/oauth/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return (
    <div className="mb-4">
      <a
        href={href}
        className="block w-full text-center bg-zinc-100 hover:bg-white text-black font-semibold rounded-lg px-4 py-2.5 transition"
      >
        Sign in with CoinPay
      </a>
      <div className="flex items-center gap-3 my-4 text-xs text-zinc-500">
        <span className="h-px flex-1 bg-zinc-800" />or use email<span className="h-px flex-1 bg-zinc-800" />
      </div>
    </div>
  );
}
