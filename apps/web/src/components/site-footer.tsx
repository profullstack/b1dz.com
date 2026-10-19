import { Footer } from '@profullstack/footer/react';
import { AdUnit } from './ad-unit';

/**
 * The shared Profullstack footer (@profullstack/footer): links, copyright and the
 * Profullstack webring. An async server component: the template is fetched from
 * the package's @latest on the CDN at render time, so a footer release reaches
 * this site without a redeploy. Colors inherit from the wrapper.
 */
export function SiteFooter() {
  return (
    <div className="text-zinc-400">
      <AdUnit />
      <Footer
        site="https://b1dz.com/"
        links={[{ label: 'GitHub', href: 'https://github.com/profullstack/b1dz.com' }]}
        tagline="AI Arbitrage Terminal"
      />
    </div>
  );
}
