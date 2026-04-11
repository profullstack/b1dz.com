declare module 'blessed' {
  const blessed: {
    screen(opts?: Record<string, unknown>): unknown;
    box(opts?: Record<string, unknown>): unknown;
    list(opts?: Record<string, unknown>): unknown;
    textbox(opts?: Record<string, unknown>): unknown;
  };
  export = blessed;
}

declare module 'react-blessed' {
  import type { ReactNode } from 'react';
  export function render(element: ReactNode, screen: unknown): void;
}

declare module 'blessed-contrib' {
  const contrib: Record<string, unknown>;
  export = contrib;
}
