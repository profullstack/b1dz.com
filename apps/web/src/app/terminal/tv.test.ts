import { describe, expect, it } from 'vitest';
import { TV_CACHE_TTL_MS, TV_CHANNELS, findProblem, lineupFrom, nextChannel, readTvCache, sourceFor, writeTvCache, type TvMatch } from './tv';

const SITE = 'https://hdtilt.com';
const ts: TvMatch = { id: 'c1', name: 'US| CNBC HD', play: { kind: 'mpegts', src: '/p/abc/7.ts', hls: '/hls/abc/index.m3u8' } };
const hls: TvMatch = { id: 'b1', name: 'Bloomberg TV', play: { kind: 'hls', src: '/p/def/index.m3u8' } };

describe('lineup', () => {
  it('offers CNBC, Bloomberg and Fox Business', () => {
    expect(TV_CHANNELS.map((c) => c.label)).toEqual(['CNBC', 'Bloomberg', 'Fox Business']);
  });

  it('takes the best match of each channel asked for', () => {
    const lineup = lineupFrom({
      results: [
        { q: 'cnbc', matches: [ts, { ...ts, id: 'c2', name: 'CNBC World' }] },
        { q: 'bloomberg', matches: [hls] },
        { q: 'fox business', matches: [] },
        { q: 'something else', matches: [hls] },
      ],
    });
    expect(Object.keys(lineup)).toEqual(['cnbc', 'bloomberg']);
    expect(lineup.cnbc.name).toBe('US| CNBC HD');
    expect(lineupFrom({})).toEqual({});
  });

  it('steps through the channels the lineup has, both ways', () => {
    const lineup = { cnbc: ts, foxbusiness: hls };
    expect(nextChannel(null, lineup)).toBe('cnbc');
    expect(nextChannel('cnbc', lineup)).toBe('foxbusiness');
    expect(nextChannel('foxbusiness', lineup)).toBe('cnbc');
    expect(nextChannel('cnbc', lineup, -1)).toBe('foxbusiness');
    expect(nextChannel('cnbc', {})).toBeNull();
  });
});

describe('sourceFor', () => {
  it('plays a transport stream as is when the browser has Media Source Extensions', () => {
    expect(sourceFor(ts, SITE, true)).toEqual({ src: 'https://hdtilt.com/p/abc/7.ts', kind: 'mpegts' });
  });
  it('asks for HLS when it does not', () => {
    expect(sourceFor(ts, SITE, false)).toEqual({ src: 'https://hdtilt.com/hls/abc/index.m3u8', kind: 'hls' });
    expect(sourceFor({ ...ts, play: { kind: 'mpegts', src: '/p/abc/7.ts' } }, SITE, false).kind).toBe('mpegts');
  });
  it('leaves HLS and absolute addresses alone', () => {
    expect(sourceFor(hls, `${SITE}/`, false)).toEqual({ src: 'https://hdtilt.com/p/def/index.m3u8', kind: 'hls' });
    expect(sourceFor({ ...hls, play: { kind: 'hls', src: 'https://cdn.example/x.m3u8' } }, SITE, true).src).toBe('https://cdn.example/x.m3u8');
  });
});

describe('cache', () => {
  const now = 1_800_000_000_000;
  it('round-trips a lineup for the same site while it is fresh', () => {
    const raw = writeTvCache({ cnbc: ts }, SITE, now);
    expect(readTvCache(raw, SITE, now + 1000)).toEqual({ cnbc: ts });
    expect(readTvCache(raw, SITE, now + TV_CACHE_TTL_MS + 1)).toBeNull();
    expect(readTvCache(raw, 'https://other.example', now)).toBeNull();
  });
  it('ignores junk', () => {
    expect(readTvCache(null, SITE, now)).toBeNull();
    expect(readTvCache('{nope', SITE, now)).toBeNull();
    expect(readTvCache(JSON.stringify({ at: now, site: SITE, lineup: { cnbc: { name: 'x', play: { kind: 'rtmp', src: '/x' } } } }), SITE, now)).toBeNull();
  });
});

describe('findProblem', () => {
  it('says what to do for each refusal', () => {
    expect(findProblem(423, 'vault_locked', SITE)).toMatchObject({ href: SITE, action: 'open hdtilt.com' });
    expect(findProblem(423, undefined, SITE).text).toMatch(/locked/);
    expect(findProblem(404, 'no_playlist', SITE).text).toMatch(/no playlist/);
    expect(findProblem(401, 'signin', SITE).text).toMatch(/Connect again/);
    expect(findProblem(429, undefined, SITE).text).toMatch(/busy/);
    expect(findProblem(502, undefined, SITE).text).toMatch(/HTTP 502/);
  });
});
