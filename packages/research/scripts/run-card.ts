/**
 * Run cards against the live sources, from the repo root:
 *
 *   pnpm exec tsx packages/research/scripts/run-card.ts <card-id> [name=value ...] [--json]
 *   pnpm exec tsx packages/research/scripts/run-card.ts --list [prefix]
 *   pnpm exec tsx packages/research/scripts/run-card.ts --all [prefix]     one line per card: ok / FAIL
 *   pnpm exec tsx packages/research/scripts/run-card.ts --search <query>
 */
import { createContext, registry, renderCard, MissingKeyError } from '../src/index.js';

const args = process.argv.slice(2);
const reg = registry();
const ctx = createContext();

function params(list: string[]): Record<string, string> {
  return Object.fromEntries(list.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
}

const dangling = reg.danglingCards();
if (dangling.length) console.error(`dashboards reference missing cards:\n  ${dangling.join('\n  ')}`);

if (args[0] === '--list') {
  for (const c of reg.allCards()) if (!args[1] || c.id.startsWith(args[1])) console.log(`${c.id.padEnd(40)} ${c.title}  [${c.source}]${c.needsKey ? `  key:${c.needsKey}` : ''}`);
} else if (args[0] === '--search') {
  console.log(JSON.stringify(await reg.search(ctx, args.slice(1).join(' ')), null, 2));
} else if (args[0] === '--all') {
  let failed = 0;
  const cards = reg.allCards().filter((c) => !args[1] || c.id.startsWith(args[1]));
  for (const c of cards) {
    const t = Date.now();
    try {
      const r = await reg.run(ctx, c.id, {});
      const size = r.blocks.reduce((n, b) => n + (b.kind === 'table' ? b.rows.length : b.kind === 'chart' ? b.series.reduce((m, s) => m + s.points.length, 0) : b.kind === 'stats' ? b.items.length : b.text.length ? 1 : 0), 0);
      const empty = size === 0;
      if (empty) failed++;
      console.log(`${empty ? 'EMPTY' : 'ok   '} ${c.id.padEnd(40)} ${String(Date.now() - t).padStart(6)}ms  ${r.blocks.length} blocks, ${size} items  [${r.source}]`);
    } catch (e) {
      if (e instanceof MissingKeyError) console.log(`key   ${c.id.padEnd(40)} needs ${e.keyName}`);
      else {
        failed++;
        console.log(`FAIL  ${c.id.padEnd(40)} ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  console.log(`${cards.length} cards, ${failed} failing`);
  process.exit(failed ? 1 : 0);
} else if (args[0]) {
  try {
    const r = await reg.run(ctx, args[0], params(args.slice(1)));
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`\x1b[1m${r.title}\x1b[0m  \x1b[2mSource: ${r.source}${r.asOf ? `  as of ${r.asOf}` : ''}\x1b[0m`);
      console.log(renderCard(r, { width: Math.min(process.stdout.columns ?? 120, 140), color: 'ansi', maxRows: 40 }).join('\n'));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.log('usage: run-card.ts <card-id> [name=value ...] [--json] | --list [prefix] | --all [prefix] | --search <query>');
}
