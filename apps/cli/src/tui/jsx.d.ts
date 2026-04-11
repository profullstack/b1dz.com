// Augment React's JSX namespace for react-blessed widget elements
import 'react';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
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
}
