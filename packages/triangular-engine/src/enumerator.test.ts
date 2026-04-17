import { describe, it, expect } from 'vitest';
import { enumerateTriangles, triangleLabel } from './enumerator.js';

describe('enumerateTriangles', () => {
  it('produces N * (N-1) triangles for N non-anchor tokens', () => {
    const tokens = ['USDC', 'WETH', 'AERO', 'DEGEN'];
    const out = enumerateTriangles('USDC', tokens);
    // 3 non-anchor tokens → 3 × 2 = 6 triangles.
    expect(out.length).toBe(6);
  });

  it('excludes the anchor from midpoints', () => {
    const tokens = ['USDC', 'WETH', 'AERO'];
    const out = enumerateTriangles('USDC', tokens);
    for (const t of out) {
      expect(t.midA.toUpperCase()).not.toBe('USDC');
      expect(t.midB.toUpperCase()).not.toBe('USDC');
      expect(t.midA).not.toBe(t.midB);
    }
  });

  it('includes both directions of every midpoint pair', () => {
    const out = enumerateTriangles('USDC', ['USDC', 'WETH', 'AERO']);
    const labels = out.map(triangleLabel);
    expect(labels).toContain('USDC→WETH→AERO→USDC');
    expect(labels).toContain('USDC→AERO→WETH→USDC');
  });

  it('handles anchor case-insensitively', () => {
    const out = enumerateTriangles('usdc', ['USDC', 'WETH', 'AERO']);
    expect(out.length).toBe(2);
  });
});
