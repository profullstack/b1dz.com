'use client';

import Script from 'next/script';
import { useEffect, useRef } from 'react';
import { AD_SCRIPT_SRC, AD_SLOT, requestAdScan, type AdFormat } from '@/lib/ads';

/**
 * One CrawlProof ad unit. Race-free: the div is server-rendered with
 * `data-cp-ad` but without `data-slot`, so ad.js's own DOMContentLoaded pass
 * skips it. The mount effect sets slot + the low-profile text_link format
 * (one thin line, every viewport), then scans.
 * The unit is zero-height until ad.js marks it `data-cp-filled` (globals.css),
 * so an unsold or blocked slot leaves no hole. ad.js draws its own label.
 */
export function AdUnit() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.dataset.slot) return;
    const format: AdFormat = 'text_link';
    el.dataset.format = format;
    el.dataset.slot = AD_SLOT;
    return requestAdScan();
  }, []);

  return (
    <>
      <div className="mx-auto max-w-6xl px-6">
        <div ref={ref} data-cp-ad="" className="cp-ad-unit" />
      </div>
      <Script src={AD_SCRIPT_SRC} strategy="afterInteractive" />
    </>
  );
}
