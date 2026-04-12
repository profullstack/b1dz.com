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

  screen.key(['a'], () => {
    tuiEvents.emit('set-log-tab', 'activity');
  });

  screen.key(['l'], () => {
    tuiEvents.emit('set-log-tab', 'logs');
  });

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
