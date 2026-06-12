'use client';

/**
 * Sign-out button that clears this browser's b1dz client-side cache before the
 * server logout. Logout is a server form POST (clears the session cookie), which
 * can't touch localStorage — so without this, cached dashboard state (e.g.
 * b1dz:source-state:*) would linger for the next account on a shared browser.
 * Defense-in-depth on top of the per-user cache keying.
 */
export function SignOutForm({ className }: { className?: string }) {
  const clearClientCache = () => {
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('b1dz:')) window.localStorage.removeItem(key);
      }
    } catch { /* private mode / quota */ }
  };
  return (
    <form action="/api/auth/logout" method="POST" onSubmit={clearClientCache}>
      <button className={className}>Sign out</button>
    </form>
  );
}
