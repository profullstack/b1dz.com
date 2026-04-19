import { describe, it, expect } from 'vitest';
import { PLUGIN_CATALOG, listCatalog } from './plugin-catalog.js';

describe('plugin catalog', () => {
  it('lists all entries when called without a kind', () => {
    expect(listCatalog()).toEqual(PLUGIN_CATALOG);
    expect(listCatalog().length).toBeGreaterThan(0);
  });

  it('filters by kind', () => {
    const connectors = listCatalog('connector');
    const strategies = listCatalog('strategy');
    expect(connectors.every((e) => e.manifest.kind === 'connector')).toBe(true);
    expect(strategies.every((e) => e.manifest.kind === 'strategy')).toBe(true);
    expect(connectors.length + strategies.length).toBe(PLUGIN_CATALOG.length);
  });

  it('has unique plugin ids', () => {
    const ids = PLUGIN_CATALOG.map((e) => e.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every manifest has required fields', () => {
    for (const { manifest } of PLUGIN_CATALOG) {
      expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(['connector', 'strategy']).toContain(manifest.kind);
      expect(manifest.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a recognized status and pricing model', () => {
    const validStatuses = new Set(['ready', 'preview', 'coming-soon']);
    const validPricing = new Set(['free', 'subscription', 'revshare']);
    for (const entry of PLUGIN_CATALOG) {
      expect(validStatuses.has(entry.status)).toBe(true);
      expect(validPricing.has(entry.pricing.model)).toBe(true);
    }
  });

  it('connector capabilities encode a chain and a venue', () => {
    for (const entry of listCatalog('connector')) {
      const caps = entry.manifest.capabilities;
      expect(caps.some((c) => c.startsWith('chain:'))).toBe(true);
      expect(caps.some((c) => c.startsWith('venue:'))).toBe(true);
    }
  });
});
