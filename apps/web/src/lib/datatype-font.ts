import localFont from 'next/font/local';

/** Datatype variable font (OpenType ligatures render `{l:v1,v2,...}`
 *  as inline sparklines). Loaded once at module scope so the font is
 *  preloaded site-wide and shares a single hash across all callers. */
export const datatypeFont = localFont({
  src: '../app/fonts/Datatype.woff2',
  display: 'swap',
  weight: '100 900',
  preload: true,
  variable: '--font-datatype',
});
