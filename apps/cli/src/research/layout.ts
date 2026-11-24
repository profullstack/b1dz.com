/** Pure layout helpers for the research TUI (no blessed here, so they are unit tested). */
import type { DashboardDef } from '@b1dz/research';

/** Printed width of a blessed-tagged string: tags take no room, {open}/{close} are one cell each. */
export function visibleLength(s: string): number {
  return s.replace(/\{(open|close)\}/g, 'x').replace(/\{[^{}]*\}/g, '').length;
}

export function padVisible(s: string, width: number): string {
  const n = visibleLength(s);
  return n >= width ? s : s + ' '.repeat(width - n);
}

/** Two blocks of lines next to each other, the left one padded to `colWidth`. */
export function sideBySide(left: string[], right: string[], colWidth: number, gap = 2): string[] {
  const out: string[] = [];
  const spacer = ' '.repeat(gap);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? '';
    const r = right[i];
    out.push(r === undefined ? l : `${padVisible(l, colWidth)}${spacer}${r}`);
  }
  return out;
}

export type SidebarItem = { kind: 'group'; label: string } | { kind: 'dashboard'; label: string; index: number };

/** Sidebar rows: a header per group, then that group's dashboards, in registry order. */
export function sidebarItems(dashboards: Pick<DashboardDef, 'title' | 'group'>[]): SidebarItem[] {
  const out: SidebarItem[] = [];
  let group = '';
  dashboards.forEach((d, index) => {
    if (d.group !== group) {
      group = d.group;
      out.push({ kind: 'group', label: group });
    }
    out.push({ kind: 'dashboard', label: d.title, index });
  });
  return out;
}

/** First visible row so that `selected` stays inside a window of `height` rows. */
export function windowStart(selected: number, height: number, total: number, current: number): number {
  if (total <= height) return 0;
  let start = current;
  if (selected < start) start = selected;
  if (selected >= start + height) start = selected - height + 1;
  return Math.max(0, Math.min(start, total - height));
}

/** The next value in a cycle; an unknown current value starts at the first. */
export function cycle<T>(values: readonly T[], current: T, step: 1 | -1): T {
  const i = values.indexOf(current);
  if (i < 0) return values[0];
  return values[(i + step + values.length) % values.length];
}
