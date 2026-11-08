import { describe, expect, it } from 'vitest';
import { isLockedKrakenAsset, krakenPairForAsset } from './index.js';

describe('kraken asset mapping', () => {
  it('maps legacy X-prefixed codes to real pairs', () => {
    expect(krakenPairForAsset('XLTC')).toBe('LTC-USD');
    expect(krakenPairForAsset('XXBT')).toBe('BTC-USD');
    expect(krakenPairForAsset('XETH')).toBe('ETH-USD');
  });

  it('trades auto-earn (.F) balances as the base asset', () => {
    expect(krakenPairForAsset('XLTC.F')).toBe('LTC-USD');
    expect(krakenPairForAsset('SOL.F')).toBe('SOL-USD');
  });

  it('leaves plain modern codes alone (no blind X/Z stripping)', () => {
    expect(krakenPairForAsset('XTZ')).toBe('XTZ-USD');
    expect(krakenPairForAsset('ZRX')).toBe('ZRX-USD');
  });

  it('treats staked, bonded and locked balances as unsellable', () => {
    for (const a of ['SOL.S', 'INJ.B', 'HYPE.B', 'DOT.M', 'KSM.P']) expect(isLockedKrakenAsset(a)).toBe(true);
    for (const a of ['SOL', 'XLTC.F', 'XXBT']) expect(isLockedKrakenAsset(a)).toBe(false);
  });
});
