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

  screen.key(['q', 'C-c'], () => {
    process.exit(0);
  });

  screen.key(['t'], () => {
    tuiEvents.emit('toggle-auto-trade');
  });

  render(<CryptoDashboard />, screen);
}
