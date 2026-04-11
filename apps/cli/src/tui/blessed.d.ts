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

// react-blessed maps blessed widget names to JSX intrinsic elements
declare namespace JSX {
  interface IntrinsicElements {
    box: Record<string, unknown>;
    text: Record<string, unknown>;
    list: Record<string, unknown>;
    textbox: Record<string, unknown>;
    button: Record<string, unknown>;
    progressbar: Record<string, unknown>;
    table: Record<string, unknown>;
    line: Record<string, unknown>;
    [key: string]: Record<string, unknown>;
  }
}
