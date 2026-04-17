import React from 'react';

// Stylized brand-inspired marks for the supported-venues section on the
// homepage. These are NOT the official trademarked logos — swap in the
// real press-kit SVGs when you want to ship trademark-accurate branding.
// Each tile is a 48x48 rounded square with the venue's accent color.

function Tile({ bg, children, title }: { bg: string; children: React.ReactNode; title: string }) {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={title}
      role="img"
    >
      <title>{title}</title>
      <rect width="48" height="48" rx="10" fill={bg} />
      {children}
    </svg>
  );
}

function Letter({ text, fill = '#fff', size = 24 }: { text: string; fill?: string; size?: number }) {
  return (
    <text
      x="24"
      y="24"
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      fontSize={size}
      fontWeight="700"
      fill={fill}
    >
      {text}
    </text>
  );
}

export function KrakenLogo() {
  return <Tile bg="#5741D9" title="Kraken"><Letter text="K" /></Tile>;
}

export function CoinbaseLogo() {
  return (
    <Tile bg="#0052FF" title="Coinbase">
      <circle cx="24" cy="24" r="12" fill="none" stroke="#fff" strokeWidth="4" />
      <rect x="19" y="21" width="10" height="6" rx="1" fill="#0052FF" />
    </Tile>
  );
}

export function BinanceLogo() {
  return (
    <Tile bg="#F0B90B" title="Binance.US">
      {/* Four-diamond motif rendered with rotated squares */}
      <g transform="translate(24 24) rotate(45)" fill="#000">
        <rect x="-3" y="-13" width="6" height="6" rx="1" />
        <rect x="7" y="-3" width="6" height="6" rx="1" />
        <rect x="-3" y="7" width="6" height="6" rx="1" />
        <rect x="-13" y="-3" width="6" height="6" rx="1" />
        <rect x="-3" y="-3" width="6" height="6" rx="1" />
      </g>
    </Tile>
  );
}

export function GeminiLogo() {
  return (
    <Tile bg="#00DCFA" title="Gemini">
      {/* Roman numeral II — the astrological gemini glyph */}
      <g stroke="#0a1931" strokeWidth="3" strokeLinecap="round">
        <line x1="18" y1="14" x2="18" y2="34" />
        <line x1="30" y1="14" x2="30" y2="34" />
        <line x1="14" y1="14" x2="22" y2="14" />
        <line x1="26" y1="14" x2="34" y2="14" />
        <line x1="14" y1="34" x2="22" y2="34" />
        <line x1="26" y1="34" x2="34" y2="34" />
      </g>
    </Tile>
  );
}

export function UniswapLogo() {
  return (
    <Tile bg="#FF007A" title="Uniswap V3">
      <Letter text="U" />
    </Tile>
  );
}

export function ZeroExLogo() {
  return (
    <Tile bg="#000" title="0x">
      <Letter text="0x" size={22} />
    </Tile>
  );
}

export function OneInchLogo() {
  return (
    <Tile bg="#1B314F" title="1inch">
      <Letter text="1" fill="#D82122" />
    </Tile>
  );
}

export function JupiterLogo() {
  return (
    <Tile bg="#0B0B0B" title="Jupiter">
      {/* Concentric rings hinting at a planet silhouette */}
      <circle cx="24" cy="24" r="10" fill="#C7F284" />
      <ellipse cx="24" cy="24" rx="16" ry="5" fill="none" stroke="#FBA43A" strokeWidth="2" transform="rotate(-18 24 24)" />
    </Tile>
  );
}

export function PumpFunLogo() {
  return (
    <Tile bg="#00D18C" title="Pump.fun">
      {/* Simple upward chevron */}
      <path d="M14 30 L24 18 L34 30" fill="none" stroke="#000" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </Tile>
  );
}

export function UniswapV4Logo() {
  return (
    <Tile bg="#FF007A" title="Uniswap V4">
      <Letter text="V4" size={20} />
    </Tile>
  );
}

export function PancakeSwapLogo() {
  return (
    <Tile bg="#1FC7D4" title="PancakeSwap">
      {/* Stack of pancakes */}
      <g fill="#fff" stroke="#0a1931" strokeWidth="1.5">
        <ellipse cx="24" cy="18" rx="11" ry="3" />
        <ellipse cx="24" cy="24" rx="12" ry="3.2" />
        <ellipse cx="24" cy="30" rx="11" ry="3" />
      </g>
    </Tile>
  );
}

export function RaydiumLogo() {
  return (
    <Tile bg="#3A1B68" title="Raydium">
      <Letter text="R" fill="#C4F454" />
    </Tile>
  );
}

export function OrcaLogo() {
  return (
    <Tile bg="#FFD15C" title="Orca">
      {/* Whale fluke silhouette */}
      <path d="M10 30 Q18 20 24 22 Q30 20 38 30 Q32 26 24 28 Q16 26 10 30 Z" fill="#0a1931" />
      <circle cx="20" cy="24" r="1.5" fill="#fff" />
    </Tile>
  );
}

export function AerodromeLogo() {
  return (
    <Tile bg="#0433FF" title="Aerodrome">
      {/* Stylized runway / paper plane */}
      <path d="M10 30 L38 14 L32 22 L18 22 L14 30 Z" fill="#fff" />
    </Tile>
  );
}
