const RING = 'https://rssamplifier.com/ring/profullstack';
const FROM = encodeURIComponent('https://b1dz.com/');

/** Profullstack OpenWebring links: previous / ring home / next. */
export function Webring({ className = '' }: { className?: string }) {
  const link = 'text-zinc-400 underline-offset-4 transition hover:text-zinc-200 hover:underline';
  return (
    <nav className={`webring flex justify-center gap-3 ${className}`} aria-label="Profullstack webring">
      <a href={`${RING}/previous?from=${FROM}`} rel="prev" className={link}>{"<<"}</a>
      <a href={RING} className={link}>Profullstack</a>
      <a href={`${RING}/next?from=${FROM}`} rel="next" className={link}>{">>"}</a>
    </nav>
  );
}
