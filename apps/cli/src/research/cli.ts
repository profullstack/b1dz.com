/**
 * `b1dz research`: market research in the terminal.
 *
 * With no arguments (or a dashboard id) it opens the TUI. The other
 * subcommands print the same cards as plain text, JSON or CSV, for scripts
 * and agents. No b1dz account is needed: every source is public.
 */
import {
  KEY_INFO,
  KEY_NAMES,
  MissingKeyError,
  cardToCsv,
  createContext,
  registry as researchRegistry,
  renderCard,
  type KeyName,
} from '@b1dz/research';
import { ResearchStore, storePath } from './store.js';

export const RESEARCH_USAGE = `b1dz: the terminal (research, watchlist, account, buy and sell)
In a browser: https://b1dz.com/terminal

  b1dz                                     open the terminal (same as b1dz research)
  b1dz research                            open the terminal
  b1dz research <dashboard> [name=value]   open on a dashboard, e.g. b1dz research company symbol=NVDA
  b1dz research list [prefix]              dashboards, tabs and card ids
  b1dz research card <id> [name=value ...] one card as text   (--json | --csv | --width N)
  b1dz research quote <symbol ...>         quote board for some tickers
  b1dz research search <query>             find a ticker, company, dataset or dashboard (--json)
  b1dz research watchlist [+SYM -SYM name] show or edit your watchlists
                                           (in the TUI: a account, b buy, x sell; see b1dz trade help)
  b1dz research keys                       optional free API keys and whether each is set
  b1dz research keys set <NAME> <value>    save a key (FRED, EIA, BLS, CONGRESS)
  b1dz research keys unset <NAME>

Equities, options, rates, credit, FX, futures, energy, shipping, macro, SEC
filings and news from public and official sources. Most cards need no key.
Research only: quotes can be delayed, and nothing here is investment advice.
State lives in ${storePath()}.`;

function parseParams(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const at = a.indexOf('=');
    if (at > 0 && !a.startsWith('--')) out[a.slice(0, at)] = a.slice(at + 1);
  }
  return out;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runResearchCli(args: string[]): Promise<number> {
  const store = new ResearchStore();
  const reg = researchRegistry();
  const ctx = createContext({ keys: store.state.keys });
  const [cmd, ...rest] = args;
  const json = args.includes('--json');
  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(RESEARCH_USAGE);
    return 0;
  }

  if (cmd === 'list') {
    const prefix = rest.find((a) => !a.startsWith('--'));
    if (json) {
      console.log(JSON.stringify(reg.catalog(), null, 2));
      return 0;
    }
    let group = '';
    for (const d of reg.dashboards) {
      if (prefix && !d.id.startsWith(prefix) && !d.tabs.some((t) => t.cards.some((c) => c.startsWith(prefix)))) continue;
      if (d.group !== group) {
        group = d.group;
        console.log(`\n${group}`);
      }
      console.log(`  ${d.id.padEnd(14)} ${d.title}`);
      for (const t of d.tabs) {
        console.log(`    ${t.title}`);
        for (const id of t.cards) {
          const c = reg.card(id);
          if (!c || (prefix && !id.startsWith(prefix) && !d.id.startsWith(prefix))) continue;
          const ps = (c.params ?? []).map((p) => `${p.name}=${p.default ?? ''}`).join(' ');
          console.log(`      ${id.padEnd(36)} ${c.title}${c.needsKey ? `  [needs ${c.needsKey} key]` : ''}${ps ? `  (${ps})` : ''}`);
        }
      }
    }
    console.log(`\n${reg.allCards().length} cards on ${reg.dashboards.length} dashboards. Run one with: b1dz research card <id> [name=value ...]`);
    return 0;
  }

  if (cmd === 'card' || cmd === 'quote') {
    const id = cmd === 'quote' ? 'overview.watchlist' : rest[0];
    const given = cmd === 'quote' ? { symbols: rest.filter((a) => !a.startsWith('--')).join(',').toUpperCase() } : parseParams(rest.slice(1));
    if (!id || (cmd === 'quote' && !given.symbols)) {
      console.error(cmd === 'quote' ? 'usage: b1dz research quote <symbol ...>' : 'usage: b1dz research card <id> [name=value ...]   (ids: b1dz research list)');
      return 2;
    }
    if (!reg.card(id)) {
      const near = reg.allCards().filter((c) => c.id.includes(id) || c.title.toLowerCase().includes(id.toLowerCase())).slice(0, 8);
      console.error(`unknown card: ${id}${near.length ? `\ndid you mean:\n${near.map((c) => `  ${c.id.padEnd(36)} ${c.title}`).join('\n')}` : ''}`);
      return 2;
    }
    try {
      const run = await reg.run(ctx, id, given);
      if (json) console.log(JSON.stringify(run, null, 2));
      else if (args.includes('--csv')) process.stdout.write(cardToCsv(run.title, run.source, run));
      else {
        const width = Number(flag(args, '--width')) || Math.min(process.stdout.columns ?? 120, 160);
        const ps = Object.entries(run.params).map(([k, v]) => `${k}=${v}`).join(' ');
        const head = `${run.title}${ps ? `  ${ps}` : ''}`;
        const sub = `Source: ${run.source}${run.asOf ? `  as of ${run.asOf}` : ''}${run.sourceUrl ? `  ${run.sourceUrl}` : ''}`;
        console.log(useColor ? `\x1b[1m${head}\x1b[0m\n\x1b[2m${sub}\x1b[0m` : `${head}\n${sub}`);
        console.log(renderCard(run, { width, color: useColor ? 'ansi' : 'none', chartHeight: 12 }).join('\n'));
      }
      return 0;
    } catch (e) {
      if (json) console.log(JSON.stringify({ error: (e as Error).message, needsKey: e instanceof MissingKeyError ? e.keyName : undefined }));
      else console.error((e as Error).message);
      return 1;
    }
  }

  if (cmd === 'search') {
    const q = rest.filter((a) => !a.startsWith('--')).join(' ');
    if (!q) {
      console.error('usage: b1dz research search <query>');
      return 2;
    }
    const hits = await reg.search(ctx, q, 25);
    if (json) console.log(JSON.stringify(hits, null, 2));
    else if (!hits.length) console.log(`nothing found for "${q}"`);
    else {
      for (const h of hits) {
        const ps = Object.entries(h.params ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`${h.kind.padEnd(9)} ${h.label}${h.detail ? `  (${h.detail})` : ''}\n          b1dz research ${h.dashboard}${ps ? ` ${ps}` : ''}`);
      }
    }
    return 0;
  }

  if (cmd === 'watchlist') {
    const edit = rest.filter((a) => !a.startsWith('--')).join(' ');
    if (edit) console.log(store.editWatchlist(edit));
    if (json) console.log(JSON.stringify({ active: store.state.activeWatchlist, watchlists: store.state.watchlists }, null, 2));
    else for (const [name, list] of Object.entries(store.state.watchlists)) console.log(`${name === store.state.activeWatchlist ? '*' : ' '} ${name.padEnd(14)} ${list.join(' ') || '(empty)'}`);
    return 0;
  }

  if (cmd === 'keys') {
    const [action, rawName, value] = rest;
    if (action === 'set' || action === 'unset') {
      const name = (rawName ?? '').toUpperCase() as KeyName;
      if (!KEY_NAMES.includes(name) || (action === 'set' && !value)) {
        console.error(`usage: b1dz research keys set <${KEY_NAMES.join('|')}> <value>   |   b1dz research keys unset <NAME>`);
        return 2;
      }
      store.setKey(name, action === 'set' ? value : undefined);
      console.log(`${name} key ${action === 'set' ? 'saved' : 'removed'} (${storePath()})`);
      return 0;
    }
    for (const k of KEY_NAMES) {
      const from = store.state.keys[k] ? 'saved' : process.env[KEY_INFO[k].env] ? `env ${KEY_INFO[k].env}` : 'not set';
      console.log(`${k.padEnd(9)} ${from.padEnd(22)} ${KEY_INFO[k].adds}\n${' '.repeat(33)}free key: ${KEY_INFO[k].signup}`);
    }
    console.log('\nKeys stay on this machine and are sent only to the provider they belong to.');
    return 0;
  }

  // Anything else opens the TUI: no command, or a dashboard id with optional params.
  const dashboards = reg.dashboards.map((d) => d.id);
  if (cmd && !cmd.includes('=') && !cmd.startsWith('--') && !dashboards.includes(cmd)) {
    console.error(`unknown command or dashboard: ${cmd}\n\n${RESEARCH_USAGE}\n\ndashboards: ${dashboards.join(', ')}`);
    return 2;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('b1dz needs an interactive terminal for the TUI (or open https://b1dz.com/terminal).\nFor scripts use: b1dz research card <id> [name=value ...] --json   (see: b1dz research help)');
    return 2;
  }
  const { startResearchTui } = await import('./tui.js');
  const dashboard = cmd && dashboards.includes(cmd) ? cmd : undefined;
  const params = parseParams(args);
  const tab = rest.find((a) => !a.includes('=') && !a.startsWith('--'));
  const { tradeClient } = await import('../trade.js');
  const { tvWatch } = await import('../tv.js');
  startResearchTui({ registry: reg, ctx, store, trader: tradeClient(), watchTv: (c) => tvWatch(c), start: { dashboard: dashboard ?? (Object.keys(params).length ? 'summary' : undefined), tab, params } });
  // The TUI owns the process from here; it exits on q.
  await new Promise(() => {});
  return 0;
}
