'use client';

/**
 * A small live TV tile for the terminal: CNBC, Bloomberg and Fox Business from
 * the viewer's own hdtilt.com account, with a pop-out to picture-in-picture.
 *
 * The streams are the viewer's: they connect their hdtilt.com account (OAuth
 * 2.1), hdtilt finds the channels by name in their playlists, and the browser
 * plays them straight from hdtilt's stream proxy with the viewer's token. This
 * site relays no video and never sees a playlist address.
 *
 * Playback is @profullstack/player's attachSource (HLS through hls.js, raw
 * transport streams through mpegts.js), so one <video> element does both and
 * the same element goes into picture-in-picture. The tile stays mounted while
 * hidden, so closing it during picture-in-picture keeps the picture.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { AttachedSource } from '@profullstack/player';
import { TV_CACHE_KEY, TV_CHANNELS, findProblem, lineupFrom, nextChannel, readTvCache, sourceFor, writeTvCache, type TvFindReply, type TvLineup } from './tv';

const LS_CHANNEL = 'b1dz:terminal:tv:channel';

export interface TvTileHandle {
  /** Step to the next (or previous) channel the lineup has. */
  zap(step: 1 | -1): void;
}

interface Token {
  connected: boolean;
  accessToken?: string;
  expiresAt?: number;
  site: string;
}
type Phase = 'idle' | 'checking' | 'connect' | 'finding' | 'ready' | 'problem';

export function TvTile(props: { ref?: Ref<TvTileHandle>; open: boolean; onClose: () => void; flash: (text: string) => void }) {
  const { open, flash } = props;
  const video = useRef<HTMLVideoElement>(null);
  const attached = useRef<AttachedSource | null>(null);
  /** One object for the life of the tile: hls.js reads it on every request, so a refreshed token is picked up in place. */
  const headers = useRef<Record<string, string>>({});
  const token = useRef<Token | null>(null);
  const refetched = useRef(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<{ text: string; href?: string; action?: string } | null>(null);
  const [lineup, setLineup] = useState<TvLineup>({});
  const [channel, setChannel] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(true);
  const [pip, setPip] = useState(false);
  const [canPip, setCanPip] = useState(false);

  // ---- token: fetched from our own cookie-backed endpoint, refreshed before it runs out
  const loadToken = useCallback(async (): Promise<Token | null> => {
    try {
      const res = await fetch('/api/tv/token', { credentials: 'same-origin', cache: 'no-store' });
      const t = (await res.json()) as Token;
      token.current = t;
      if (t.accessToken) headers.current.Authorization = `Bearer ${t.accessToken}`;
      return t;
    } catch {
      return null;
    }
  }, []);

  const find = useCallback(
    async (t: Token, force: boolean): Promise<TvLineup | null> => {
      if (!force) {
        const cached = readTvCache(window.localStorage.getItem(TV_CACHE_KEY), t.site, Date.now());
        if (cached) return cached;
      }
      setPhase('finding');
      let res: Response;
      try {
        res = await fetch(`${t.site}/api/tv/find`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${t.accessToken}` },
          body: JSON.stringify({ names: TV_CHANNELS.map((c) => c.query), limit: 1 }),
        });
      } catch {
        setProblem({ text: `Could not reach ${t.site.replace(/^https?:\/\//, '')}. Check your connection and try again.` });
        setPhase('problem');
        return null;
      }
      const body = (await res.json().catch(() => ({}))) as TvFindReply & { code?: string };
      if (!res.ok) {
        setProblem(findProblem(res.status, body.code, t.site));
        setPhase(res.status === 401 ? 'connect' : 'problem');
        return null;
      }
      const found = lineupFrom(body);
      if (!Object.keys(found).length) {
        setProblem({ text: 'None of CNBC, Bloomberg or Fox Business is in your hdtilt playlists.', href: t.site, action: 'open hdtilt' });
        setPhase('problem');
        return null;
      }
      try {
        window.localStorage.setItem(TV_CACHE_KEY, writeTvCache(found, t.site, Date.now()));
      } catch {
        /* private mode: looked up again next visit */
      }
      return found;
    },
    [],
  );

  const start = useCallback(
    async (force = false) => {
      setProblem(null);
      setPhase('checking');
      const t = await loadToken();
      if (!t) {
        setProblem({ text: 'Could not check the TV connection. Try again.' });
        return setPhase('problem');
      }
      if (!t.connected || !t.accessToken) return setPhase('connect');
      const found = await find(t, force);
      if (!found) return;
      setLineup(found);
      setPhase('ready');
      setChannel((cur) => {
        if (cur && found[cur]) return cur;
        let last: string | null = null;
        try {
          last = window.localStorage.getItem(LS_CHANNEL);
        } catch {
          /* ignore */
        }
        return last && found[last] ? last : nextChannel(null, found);
      });
    },
    [loadToken, find],
  );

  // Open the first time: check the connection. Later opens reuse what is loaded.
  useEffect(() => {
    if (open && phase === 'idle') void start();
  }, [open, phase, start]);

  // Keep the token fresh while a channel is on (hdtilt's lasts an hour).
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = window.setInterval(() => void loadToken(), 20 * 60_000);
    return () => window.clearInterval(timer);
  }, [phase, loadToken]);

  // ---- playback -----------------------------------------------------------
  useEffect(() => {
    const el = video.current;
    const t = token.current;
    const match = channel ? lineup[channel] : undefined;
    if (!el || !t || !match || phase !== 'ready') return;
    let dead = false;
    setNotice('tuning…');
    const target = sourceFor(match, t.site, typeof window.MediaSource !== 'undefined' || 'ManagedMediaSource' in window);
    // Loaded on first use: the player and its stream engines stay out of the terminal's first paint.
    void import('@profullstack/player')
      .then(({ attachSource }) =>
        attachSource(el, {
      src: target.src,
      kind: target.kind,
      live: true,
      headers: headers.current,
      onNotice: (m) => !dead && setNotice(m ?? ''),
      onReady: () => !dead && setNotice(''),
      onError: (m) => {
        if (dead) return;
        // A cached stream address can go stale: look the channels up once more before giving up.
        if (!refetched.current) {
          refetched.current = true;
          setNotice('looking the channel up again…');
          void start(true);
        } else setNotice(m || 'This channel is not playing right now.');
      },
        }),
      )
      .then((a) => {
      if (dead) return a.destroy();
      attached.current = a;
      if (a.unplayable) return setNotice(a.unplayable);
      el.muted = true; // browsers only autoplay muted; the viewer unmutes with one click
      setMuted(true);
      void el.play().catch(() => setNotice('press play'));
    });
    try {
      window.localStorage.setItem(LS_CHANNEL, channel!);
    } catch {
      /* ignore */
    }
    return () => {
      dead = true;
      attached.current?.destroy();
      attached.current = null;
    };
  }, [channel, lineup, phase, start]);

  // ---- picture-in-picture ---------------------------------------------------
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setCanPip(Boolean(document.pictureInPictureEnabled) && typeof el.requestPictureInPicture === 'function');
    const on = () => setPip(true);
    const off = () => setPip(false);
    el.addEventListener('enterpictureinpicture', on);
    el.addEventListener('leavepictureinpicture', off);
    return () => {
      el.removeEventListener('enterpictureinpicture', on);
      el.removeEventListener('leavepictureinpicture', off);
    };
  }, []);

  const togglePip = async () => {
    const el = video.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      flash('picture-in-picture is not available for this stream yet: wait for the picture, then try again');
    }
  };

  const toggleMute = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
    if (!el.muted && el.paused) void el.play().catch(() => {});
  };

  const disconnect = async () => {
    await fetch('/api/tv/disconnect', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    try {
      window.localStorage.removeItem(TV_CACHE_KEY);
    } catch {
      /* ignore */
    }
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
    token.current = null;
    setChannel(null);
    setLineup({});
    setPhase('connect');
    flash('hdtilt disconnected');
  };

  useImperativeHandle(
    props.ref,
    () => ({
      zap(step) {
        setChannel((cur) => nextChannel(cur, lineup, step) ?? cur);
      },
    }),
    [lineup],
  );

  // Closing the tile stops the channel, unless the picture is popped out.
  const playing = phase === 'ready' && channel !== null;
  useEffect(() => {
    if (!open && !pip && playing) setChannel(null);
  }, [open, pip, playing]);
  useEffect(() => {
    if (open && phase === 'ready' && channel === null) setChannel(nextChannel(null, lineup));
  }, [open, phase, channel, lineup]);

  const btn = 'rounded px-1.5 py-0.5 text-xs';
  const hidden = !open; // stay mounted: the <video> must outlive a closed tile while in picture-in-picture
  return (
    <section
      aria-label="Live TV"
      hidden={hidden}
      className={`${hidden ? 'hidden' : 'flex'} fixed bottom-9 right-3 z-40 w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded border border-zinc-700 bg-zinc-950 font-mono text-[13px] shadow-2xl`}
    >
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1">
        <span className="mr-1 font-semibold text-amber-300">TV</span>
        {phase === 'ready' &&
          TV_CHANNELS.map((c) => (
            <button
              key={c.key}
              type="button"
              disabled={!lineup[c.key]}
              aria-pressed={channel === c.key}
              onClick={() => {
                refetched.current = false;
                setChannel(c.key);
              }}
              title={lineup[c.key] ? `${c.label}: ${lineup[c.key].name}` : `${c.label} is not in your hdtilt playlists`}
              className={`${btn} ${channel === c.key ? 'bg-amber-400 text-zinc-950' : lineup[c.key] ? 'text-zinc-300 hover:bg-zinc-800' : 'text-zinc-700'}`}
            >
              {c.short}
            </button>
          ))}
        <span className="ml-auto flex items-center gap-0.5">
          {phase === 'ready' && (
            <>
              <button type="button" onClick={toggleMute} className={`${btn} ${muted ? 'text-amber-300' : 'text-zinc-400'} hover:bg-zinc-800`} title={muted ? 'Unmute' : 'Mute'}>
                {muted ? 'unmute' : 'mute'}
              </button>
              {canPip && (
                <button type="button" onClick={() => void togglePip()} className={`${btn} text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100`} title="Pop out to picture-in-picture (stays on top of other windows)">
                  {pip ? 'pop in' : 'pop out'}
                </button>
              )}
            </>
          )}
          <button type="button" onClick={props.onClose} className={`${btn} text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100`} aria-label="Close live TV">
            close
          </button>
        </span>
      </div>

      <div className={`relative aspect-video bg-black ${phase === 'ready' ? '' : 'hidden'}`}>
        <video ref={video} playsInline muted className={`h-full w-full ${pip ? 'opacity-0' : ''}`} />
        {(notice || pip) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-zinc-300">
            <span className="rounded bg-black/70 px-2 py-1">{pip ? 'Playing in picture-in-picture' : notice}</span>
          </div>
        )}
      </div>

      {phase !== 'ready' && (
        <div className="space-y-2 px-3 py-3 text-xs text-zinc-300">
          {(phase === 'checking' || phase === 'idle') && <p className="animate-pulse text-zinc-500">checking your TV connection…</p>}
          {phase === 'finding' && <p className="animate-pulse text-zinc-500">finding CNBC, Bloomberg and Fox Business in your playlists…</p>}
          {phase === 'connect' && (
            <>
              <p>Watch CNBC, Bloomberg and Fox Business here from your own hdtilt.com playlists.</p>
              {problem && <p className="text-amber-200">{problem.text}</p>}
              <a href="/api/tv/start" className="inline-block rounded bg-amber-400 px-3 py-1 font-semibold text-zinc-950 hover:bg-amber-300">
                Connect hdtilt
              </a>
              <p className="text-[11px] text-zinc-600">hdtilt.com is an IPTV player for a playlist you already have. This site plays your streams from your account and stores none of them.</p>
            </>
          )}
          {phase === 'problem' && problem && (
            <>
              <p className="text-amber-200">{problem.text}</p>
              <div className="flex gap-2">
                {problem.href && (
                  <a href={problem.href} target="_blank" rel="noopener noreferrer" className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:text-white">
                    {problem.action ?? 'open'} ↗
                  </a>
                )}
                <button type="button" onClick={() => void start(true)} className="rounded bg-amber-400 px-2 py-0.5 font-semibold text-zinc-950 hover:bg-amber-300">
                  try again
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {(phase === 'ready' || phase === 'problem') && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-600">
          <span className="truncate">{phase === 'ready' && channel && lineup[channel] ? lineup[channel].name : 'your hdtilt.com account'}</span>
          <button type="button" onClick={() => void disconnect()} className="ml-auto hover:text-zinc-300">
            disconnect
          </button>
        </div>
      )}
    </section>
  );
}
