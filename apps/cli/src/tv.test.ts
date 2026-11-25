import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TV_CLI_CLIENT, authorizeRequest, mpvArgs, streamUrl, tvFindError } from './tv.js';

describe('b1dz tv sign-in', () => {
  it('builds a PKCE authorization for a loopback redirect', () => {
    const fixed = (n: number) => Buffer.alloc(n, 7);
    const r = authorizeRequest('https://hdtilt.com', 51234, fixed);
    const u = new URL(r.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://hdtilt.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe(TV_CLI_CLIENT);
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(r.verifier).digest('base64url'));
    expect(u.searchParams.get('state')).toBe(r.state);
    // hdtilt requires 43 to 128 unreserved characters.
    expect(r.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it('uses fresh secrets each time', () => {
    const a = authorizeRequest('https://hdtilt.com', 1);
    const b = authorizeRequest('https://hdtilt.com', 1);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('b1dz tv playback', () => {
  it('plays the proxied stream from the site, or an absolute address as is', () => {
    expect(streamUrl({ name: 'CNBC', play: { kind: 'mpegts', src: '/p/abc/7.ts', hls: '/hls/abc/index.m3u8' } }, 'https://hdtilt.com')).toBe('https://hdtilt.com/p/abc/7.ts');
    expect(streamUrl({ name: 'X', play: { kind: 'hls', src: 'https://cdn.example/x.m3u8' } }, 'https://hdtilt.com')).toBe('https://cdn.example/x.m3u8');
  });

  it('sends the token to mpv as a header, never in the address', () => {
    const args = mpvArgs('https://hdtilt.com/p/abc/7.ts', 'ht_at_secret', 'CNBC · b1dz tv');
    expect(args[0]).toBe('--http-header-fields=Authorization: Bearer ht_at_secret');
    expect(args.at(-1)).toBe('https://hdtilt.com/p/abc/7.ts');
    expect(args.at(-1)).not.toContain('ht_at_secret');
    expect(args).toContain('--title=CNBC · b1dz tv');
  });

  it('says what to do when channels cannot be listed', () => {
    const site = 'https://hdtilt.com';
    expect(tvFindError(423, {}, site)).toMatch(/locked.*unlock it with your passphrase/);
    expect(tvFindError(404, {}, site)).toMatch(/no playlist/);
    expect(tvFindError(401, {}, site)).toMatch(/b1dz tv login/);
    expect(tvFindError(0, { error: 'ECONNREFUSED' }, site)).toMatch(/could not reach hdtilt.com: ECONNREFUSED/);
    expect(tvFindError(502, { error: 'provider down' }, site)).toMatch(/502: provider down/);
  });
});
