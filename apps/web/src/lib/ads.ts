/**
 * CrawlProof ad slot for b1dz.com. Manage it at https://crawlproof.com/ads/slots
 */
export const AD_SLOT = '7dd596c1-2700-44a2-81e2-ffea09725599';

export const AD_SCRIPT_SRC = 'https://crawlproof.com/ad.js';

export type AdFormat = 'banner_728x90' | 'text_link';

declare global {
  interface Window {
    crawlproofAds?: { scan: () => void };
  }
}

const SCAN_RETRY_MS = 200;
const SCAN_MAX_TRIES = 25;

/**
 * ad.js scans for `[data-cp-ad]` once, at DOMContentLoaded, and then only when
 * asked. A unit whose slot is set in a mount effect has to request the rescan
 * itself. Retries because ad.js loads `afterInteractive`; gives up after ~5s so
 * an ad blocker never leaves a timer spinning. `fill()` guards on
 * `data-cp-filled`, so extra scans never double-request.
 */
export function requestAdScan(): () => void {
  if (typeof window === 'undefined') return () => {};
  let cancelled = false;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (cancelled) return;
    if (window.crawlproofAds) {
      window.crawlproofAds.scan();
      return;
    }
    if (++tries > SCAN_MAX_TRIES) return;
    timer = setTimeout(tick, SCAN_RETRY_MS);
  };
  tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
