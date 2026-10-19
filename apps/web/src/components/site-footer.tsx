/**
 * The site's own footer: one row, copyright plus the code link. The network
 * links (search, ring, publish) come from the pit.world global footer that the
 * root layout renders after this (see pit-footer.tsx).
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-zinc-800 text-sm text-zinc-500">
      <div className="max-w-6xl mx-auto px-6 py-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <span>&copy; {new Date().getFullYear()} b1dz &middot; Profullstack, Inc.</span>
        <a href="https://github.com/profullstack/b1dz.com" className="hover:text-zinc-300">GitHub</a>
      </div>
    </footer>
  );
}
