/**
 * Triangular route enumerator for single-DEX cyclic arbitrage.
 *
 * A triangle is a directed cycle of length 3 that starts and ends at the
 * same anchor token:
 *
 *     anchor → midA → midB → anchor
 *
 * MVP restriction: all triangles are anchored at one configured token
 * (typically the wallet's settlement currency — USDC). This bounds the
 * search space and guarantees every profitable route produces an output
 * denominated in the anchor (no inventory management needed).
 *
 * Count: for N non-anchor tokens, N × (N - 1) directed triangles.
 * (e.g. 8 tokens → 56 routes.)
 */

export interface Triangle {
  /** Anchor symbol (start and end of the cycle). */
  anchor: string;
  /** First intermediate symbol. */
  midA: string;
  /** Second intermediate symbol. */
  midB: string;
}

/** Enumerate every directed triangle with the given anchor through every
 *  ordered pair of intermediate tokens.
 *
 *  `tokens` is the set of symbols available on the venue; the anchor
 *  must be excluded from the midpoint search (no `anchor → X → anchor →
 *  anchor`-style degeneracies).
 *
 *  Output order is stable — `(midA, midB)` pairs are iterated in the
 *  order `tokens` is given. */
export function enumerateTriangles(anchor: string, tokens: readonly string[]): Triangle[] {
  const upAnchor = anchor.toUpperCase();
  const mids = tokens.filter((t) => t.toUpperCase() !== upAnchor);
  const out: Triangle[] = [];
  for (const a of mids) {
    for (const b of mids) {
      if (a.toUpperCase() === b.toUpperCase()) continue;
      out.push({ anchor, midA: a, midB: b });
    }
  }
  return out;
}

/** Human-readable cycle label, e.g. "USDC→WETH→AERO→USDC". Used in
 *  logs, TUI rows, and opportunity IDs. */
export function triangleLabel(t: Triangle): string {
  return `${t.anchor}→${t.midA}→${t.midB}→${t.anchor}`;
}
