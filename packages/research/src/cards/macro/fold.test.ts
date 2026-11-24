import { describe, expect, it } from 'vitest';
import { foldHeadlines, normaliseTitle, titleSimilarity, type Headline } from './fold.js';

const h = (title: string, source: string, date: number | null): Headline => ({ title, source, date, link: `https://example.test/${source}/${date}` });

describe('normaliseTitle', () => {
  it('drops case, punctuation, stop words and a trailing publisher', () => {
    expect(normaliseTitle('The Fed Holds Rates Steady, Signals Patience - Example Wire')).toBe('fed holds rates steady signals patience');
    expect(normaliseTitle("Oil's slide deepens | Example Markets")).toBe('oil slide deepens');
  });
  it('keeps numbers and percentages', () => {
    expect(normaliseTitle('Stocks fall 2.5% as yields hit 5%')).toBe('stocks fall 2.5% yields hit 5%');
  });
});

describe('titleSimilarity', () => {
  it('is 1 for the same words in a different order and 0 for unrelated titles', () => {
    expect(titleSimilarity('Fed holds rates steady', 'Rates steady: Fed holds')).toBe(1);
    expect(titleSimilarity('Fed holds rates steady', 'Copper output climbs in Chile')).toBe(0);
  });
  it('is the shared share of words', () => {
    // {fed, holds, rates, steady} vs {fed, holds, rates, again}: 3 shared of 5 distinct.
    expect(titleSimilarity('Fed holds rates steady', 'Fed holds rates again')).toBeCloseTo(0.6, 10);
  });
  it('is 0 when a title has no significant words', () => {
    expect(titleSimilarity('', 'Fed holds')).toBe(0);
  });
});

describe('foldHeadlines', () => {
  it('sorts newest first and folds near-duplicates into the newest copy', () => {
    const out = foldHeadlines([
      h('Central bank holds rates steady, signals patience', 'A', 100),
      h('Copper output climbs in Chile', 'B', 300),
      h('Central bank holds rates steady and signals patience - Wire B', 'B', 200),
      h('Central bank holds rates steady, signals patience', 'A', 50),
    ]);
    expect(out.map((r) => r.title)).toEqual(['Copper output climbs in Chile', 'Central bank holds rates steady and signals patience - Wire B']);
    expect(out[1]).toMatchObject({ source: 'B', sources: ['B', 'A'], count: 3, date: 200 });
    expect(out[0]).toMatchObject({ sources: ['B'], count: 1 });
  });

  it('keeps different stories that share a few words', () => {
    const out = foldHeadlines([h('Oil prices rise on supply fears', 'A', 2), h('Oil prices fall as demand weakens', 'B', 1)]);
    expect(out).toHaveLength(2);
  });

  it('only folds very short titles when they are identical', () => {
    const out = foldHeadlines([h('Markets wrap', 'A', 3), h('Markets wrap', 'B', 2), h('Markets open', 'C', 1)]);
    expect(out.map((r) => r.count)).toEqual([2, 1]);
  });

  it('puts undated items last and does not mutate the input', () => {
    const input = [h('Undated story about tariffs today', 'A', null), h('Dated story about payrolls today', 'B', 5)];
    const out = foldHeadlines(input);
    expect(out.map((r) => r.source)).toEqual(['B', 'A']);
    expect(input[0].source).toBe('A');
  });
});
