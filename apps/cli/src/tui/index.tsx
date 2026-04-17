import React from 'react';
import blessed from 'blessed';
import { render } from 'react-blessed';
import { CryptoDashboard } from './crypto-dashboard.js';
import { tuiEvents } from './events.js';
export { tuiEvents } from './events.js';

export function startTui() {
  const screen = (blessed as any).screen({
    smartCSR: true,
    title: 'b1dz crypto',
    tags: true,
  });

  const pageLog = (delta: number) => {
    tuiEvents.emit('page-log', delta);
  };

  screen.key(['q', 'C-c'], () => {
    process.exit(0);
  });

  screen.key(['t'], () => {
    tuiEvents.emit('toggle-auto-trade');
  });

  screen.key(['d'], () => {
    tuiEvents.emit('toggle-trading-enabled');
  });

  screen.key(['a'], () => {
    tuiEvents.emit('set-log-tab', 'activity');
  });

  screen.key(['l'], () => {
    tuiEvents.emit('set-log-tab', 'logs');
  });

  screen.key(['n'], () => {
    tuiEvents.emit('set-log-tab', 'news');
  });

  // Indicator overlays on both charts
  screen.key(['e'], () => tuiEvents.emit('toggle-chart-indicator', 'ema'));
  screen.key(['m'], () => tuiEvents.emit('toggle-chart-indicator', 'sma'));
  screen.key(['b'], () => tuiEvents.emit('toggle-chart-indicator', 'bollinger'));

  screen.key(['1'], () => tuiEvents.emit('set-chart-timeframe', '1m'));
  screen.key(['2'], () => tuiEvents.emit('set-chart-timeframe', '5m'));
  screen.key(['3'], () => tuiEvents.emit('set-chart-timeframe', '15m'));
  screen.key(['4'], () => tuiEvents.emit('set-chart-timeframe', '1h'));
  screen.key(['5'], () => tuiEvents.emit('set-chart-timeframe', '4h'));
  screen.key(['6'], () => tuiEvents.emit('set-chart-timeframe', '1d'));
  screen.key(['7'], () => tuiEvents.emit('set-chart-timeframe', '1w'));
  screen.key([',', 'left'], () => tuiEvents.emit('cycle-chart-pair', -1));
  screen.key(['.', 'right'], () => tuiEvents.emit('cycle-chart-pair', 1));

  screen.key(['pageup', 'ppage', 'prior', 'S-pageup', 'C-u', 'C-b'], () => pageLog(1));
  screen.key(['pagedown', 'npage', 'next', 'S-pagedown', 'C-d', 'C-f'], () => pageLog(-1));

  screen.on('keypress', (ch: string, key: { name?: string; full?: string; sequence?: string } = {}) => {
    const name = key.name ?? '';
    const full = key.full ?? '';
    const sequence = key.sequence ?? ch ?? '';

    if (sequence === '[' || ch === '[' || full === '[') {
      pageLog(1);
      return;
    }
    if (sequence === ']' || ch === ']' || full === ']') {
      pageLog(-1);
      return;
    }

    if (name === 'pageup' || name === 'ppage' || name === 'prior' || full === 'C-u' || full === 'C-b') {
      pageLog(1);
      return;
    }
    if (name === 'pagedown' || name === 'npage' || name === 'next' || full === 'C-d' || full === 'C-f') {
      pageLog(-1);
    }
  });

  render(<CryptoDashboard />, screen);
}
