/** Government & Regulation: U.S. Congress (Congress.gov, Senate) and federal spending (USAspending). */
import { isoDate } from '../../format.js';
import { SourceError, type CardDef, type Ctx, type DashboardDef, type ParamSpec, type Row } from '../../types.js';
import { decodeEntities, plainText } from './rss.js';

const DEMO_NOTE = 'No Congress.gov key set: using the shared demo key, which allows only a few requests an hour for everyone on this network. Results are cached for an hour.';

/** The Congress sitting in `year` (the 1st met in 1789; each lasts two years from January of an odd year). */
export function congressOf(year: number): number {
  return Math.floor((year - 1789) / 2) + 1;
}

/** Session 1 is the odd first year of a Congress, session 2 the second. */
export function sessionOf(congress: number, year: number): number {
  const first = 1789 + (congress - 1) * 2;
  return Math.min(2, Math.max(1, year - first + 1));
}

const CONGRESS: ParamSpec = { name: 'congress', label: 'Congress', default: '', hint: 'number, e.g. 119; empty = the current one' };

function pickCongress(ctx: Ctx, raw: string | undefined): number {
  const current = congressOf(ctx.now().getUTCFullYear());
  if (!raw || !raw.trim()) return current;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 93 || n > current) throw new SourceError('Congress.gov', `congress must be a number from 93 to ${current}`);
  return n;
}

async function congressApi<T>(ctx: Ctx, path: string, query: string): Promise<{ body: T; demo: boolean }> {
  const key = ctx.key('CONGRESS');
  const url = `https://api.congress.gov/v3/${path}?${query}&format=json&api_key=${encodeURIComponent(key ?? 'DEMO_KEY')}`;
  const body = await ctx.http.json<T>(url, { source: 'Congress.gov', ttl: 3600, timeoutMs: 40_000 });
  return { body, demo: !key };
}

interface ApiBill {
  congress?: number;
  type?: string;
  number?: string;
  title?: string;
  originChamber?: string;
  updateDate?: string;
  latestAction?: { actionDate?: string; text?: string };
  laws?: { number?: string; type?: string }[];
}

const BILL_SLUG: Record<string, string> = {
  HR: 'house-bill', S: 'senate-bill', HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution',
  HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution', HRES: 'house-resolution', SRES: 'senate-resolution',
};

const BILL_LABEL: Record<string, string> = { HR: 'H.R.', S: 'S.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.', HRES: 'H.Res.', SRES: 'S.Res.' };

export function billLabel(type: string | undefined, number: string | undefined): string {
  const t = (type ?? '').toUpperCase();
  return `${BILL_LABEL[t] ?? t} ${number ?? ''}`.trim();
}

export function billUrl(congress: number | undefined, type: string | undefined, number: string | undefined): string {
  const slug = BILL_SLUG[(type ?? '').toUpperCase()];
  return slug && congress && number ? `https://www.congress.gov/bill/${congress}th-congress/${slug}/${number}` : 'https://www.congress.gov/';
}

export function billRows(bills: ApiBill[]): Row[] {
  return bills.map((b) => ({
    bill: billLabel(b.type, b.number),
    title: b.title ?? '',
    actionDate: b.latestAction?.actionDate ?? null,
    action: b.latestAction?.text ?? '',
    updated: b.updateDate ?? null,
    law: b.laws?.[0]?.number ?? null,
    link: billUrl(b.congress, b.type, b.number),
  }));
}

const bills: CardDef = {
  id: 'macro.congress-bills',
  title: 'Latest Bills',
  source: 'Congress.gov',
  description: 'The most recently updated bills and resolutions with their latest action.',
  params: [{ name: 'query', label: 'Filter', default: '', hint: 'word in the title or a bill number, e.g. tax or H.R. 1; empty shows all' }, CONGRESS],
  async run(ctx, p) {
    const congress = pickCongress(ctx, p.congress);
    const { body, demo } = await congressApi<{ bills?: ApiBill[] }>(ctx, `bill/${congress}`, 'limit=250&sort=updateDate+desc');
    const all = billRows(body.bills ?? []);
    if (!all.length) throw new SourceError('Congress.gov', `no bills returned for the ${congress}th Congress`);
    const q = (p.query ?? '').trim().toLowerCase();
    const squash = (s: string): string => s.toLowerCase().replace(/[\s.]/g, '');
    const matched = q ? all.filter((r) => String(r.title).toLowerCase().includes(q) || squash(String(r.bill)) === squash(q)) : all;
    const rows = [...matched].sort((a, b) => String(b.actionDate ?? '').localeCompare(String(a.actionDate ?? '')));
    if (!rows.length) throw new SourceError('Congress.gov', `none of the ${all.length} most recently updated bills match "${p.query}"`);
    const notes = [`The filter searches the ${all.length} most recently updated bills of the ${congress}th Congress, not every bill.`];
    if (demo) notes.push(DEMO_NOTE);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [{ key: 'bill', label: 'Bill' }, { key: 'title', label: 'Title', maxWidth: 64 }, { key: 'actionDate', label: 'Action date' }, { key: 'action', label: 'Latest action', maxWidth: 64 }, { key: 'link', label: 'Link', maxWidth: 40 }],
          rows: rows.slice(0, 40),
        },
      ],
      sourceUrl: 'https://www.congress.gov/',
      asOf: String(rows[0].actionDate ?? ''),
      notes,
    };
  },
};

const laws: CardDef = {
  id: 'macro.congress-laws',
  title: 'Recently Enacted Laws',
  source: 'Congress.gov',
  description: 'Bills that became public law, newest first.',
  params: [CONGRESS],
  async run(ctx, p) {
    const congress = pickCongress(ctx, p.congress);
    const { body, demo } = await congressApi<{ bills?: ApiBill[] }>(ctx, `law/${congress}`, 'limit=250');
    const rows = billRows(body.bills ?? []).sort((a, b) => String(b.actionDate ?? '').localeCompare(String(a.actionDate ?? '')) || String(b.law ?? '').localeCompare(String(a.law ?? ''), undefined, { numeric: true }));
    if (!rows.length) throw new SourceError('Congress.gov', `no laws returned for the ${congress}th Congress`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [{ key: 'law', label: 'Public law' }, { key: 'actionDate', label: 'Enacted' }, { key: 'bill', label: 'Bill' }, { key: 'title', label: 'Title', maxWidth: 80 }, { key: 'link', label: 'Link', maxWidth: 40 }],
          rows: rows.slice(0, 40),
          footnote: `${rows.length} laws listed for the ${congress}th Congress.`,
        },
      ],
      sourceUrl: `https://www.congress.gov/public-laws/${congress}th-congress`,
      asOf: String(rows[0].actionDate ?? ''),
      notes: demo ? [DEMO_NOTE] : [],
    };
  },
};

interface ApiVote {
  rollCallNumber?: number;
  sessionNumber?: number;
  startDate?: string;
  result?: string;
  voteType?: string;
  legislationType?: string;
  legislationNumber?: string;
  legislationUrl?: string;
  sourceDataURL?: string;
}

export function voteRows(votes: ApiVote[]): Row[] {
  return votes
    .filter((v) => v.startDate)
    .sort((a, b) => Date.parse(b.startDate as string) - Date.parse(a.startDate as string))
    .map((v) => ({
      date: isoDate(v.startDate as string),
      roll: v.rollCallNumber ?? null,
      measure: v.legislationType ? billLabel(v.legislationType, v.legislationNumber) : '',
      type: v.voteType ?? '',
      result: v.result ?? '',
      link: v.legislationUrl ?? v.sourceDataURL ?? '',
    }));
}

const votes: CardDef = {
  id: 'macro.congress-votes',
  title: 'House Roll-Call Votes',
  source: 'Congress.gov',
  description: 'Recent recorded votes in the House of Representatives and their result.',
  params: [CONGRESS],
  async run(ctx, p) {
    const congress = pickCongress(ctx, p.congress);
    const year = ctx.now().getUTCFullYear();
    const session = congress === congressOf(year) ? sessionOf(congress, year) : 2;
    type VotePage = { houseRollCallVotes?: ApiVote[]; pagination?: { count?: number } };
    const { body, demo } = await congressApi<VotePage>(ctx, `house-vote/${congress}/${session}`, 'limit=250');
    const list = [...(body.houseRollCallVotes ?? [])];
    const total = body.pagination?.count ?? list.length;
    // The API pages in its own order, so a busy session needs its second page before "newest" means anything.
    // It is best effort: on the shared demo key the second request can be refused, and one page is still worth showing.
    if (total > list.length && list.length === 250) {
      try {
        const more = await congressApi<VotePage>(ctx, `house-vote/${congress}/${session}`, 'limit=250&offset=250');
        list.push(...(more.body.houseRollCallVotes ?? []));
      } catch {
        // Reported below: `total > list.length` still holds, so the note says the latest votes may be missing.
      }
    }
    const rows = voteRows(list);
    if (!rows.length) throw new SourceError('Congress.gov', `no House votes returned for the ${congress}th Congress, session ${session}`);
    const notes = [`Session ${session} of the ${congress}th Congress. House votes only: the API does not publish Senate roll calls.`];
    if (total > list.length) notes.push(`The session has ${total} votes and the API returned ${list.length}, so the very latest may be missing.`);
    if (demo) notes.push(DEMO_NOTE);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [{ key: 'date', label: 'Date' }, { key: 'roll', label: 'Roll', format: 'int' }, { key: 'measure', label: 'Measure' }, { key: 'type', label: 'Vote type', maxWidth: 30 }, { key: 'result', label: 'Result' }, { key: 'link', label: 'Link', maxWidth: 50 }],
          rows: rows.slice(0, 40),
        },
      ],
      sourceUrl: 'https://clerk.house.gov/Votes',
      asOf: String(rows[0].date),
      notes,
    };
  },
};

interface ApiMember {
  name?: string;
  partyName?: string;
  state?: string;
  district?: number;
  bioguideId?: string;
  terms?: { item?: { chamber?: string; startYear?: number; endYear?: number }[] };
}

export function memberRows(members: ApiMember[]): Row[] {
  const ranked = members.map((m) => {
    const terms = m.terms?.item ?? [];
    const senate = terms[terms.length - 1]?.chamber === 'Senate';
    const first = Math.min(...terms.map((t) => t.startYear ?? Infinity));
    const row: Row = {
      name: m.name ?? '',
      party: m.partyName ?? '',
      chamber: senate ? 'Senate' : 'House',
      district: senate ? null : (m.district ?? 0) === 0 ? 'At large' : String(m.district),
      since: Number.isFinite(first) ? String(first) : null,
      link: m.bioguideId ? `https://www.congress.gov/member/${m.bioguideId}` : '',
    };
    return { row, order: senate ? -1 : (m.district ?? 0), name: m.name ?? '' };
  });
  // Senators first, then representatives by district.
  return ranked.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((r) => r.row);
}

const members: CardDef = {
  id: 'macro.congress-members',
  title: 'Members by State',
  source: 'Congress.gov',
  description: "A state's current senators and representatives.",
  params: [{ name: 'state', label: 'State', default: 'CA', hint: 'two-letter state or territory code, e.g. CA, TX, NY' }],
  async run(ctx, p) {
    const state = (p.state ?? 'CA').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw new SourceError('Congress.gov', `state must be a two-letter code, got "${p.state}"`);
    const { body, demo } = await congressApi<{ members?: ApiMember[] }>(ctx, `member/${state}`, 'limit=250&currentMember=true');
    const rows = memberRows(body.members ?? []);
    if (!rows.length) throw new SourceError('Congress.gov', `no current members for ${state}`);
    return {
      blocks: [
        {
          kind: 'table',
          title: `${body.members?.[0]?.state ?? state}: ${rows.length} members`,
          columns: [{ key: 'name', label: 'Member' }, { key: 'chamber', label: 'Chamber' }, { key: 'district', label: 'District' }, { key: 'party', label: 'Party' }, { key: 'since', label: 'In Congress since' }, { key: 'link', label: 'Link', maxWidth: 44 }],
          rows,
        },
      ],
      sourceUrl: 'https://www.congress.gov/members',
      notes: demo ? [DEMO_NOTE] : [],
    };
  },
};

export interface Hearing {
  date: string;
  time: string;
  committee: string;
  type: string;
  room: string;
  matter: string;
}

/** Meetings from the Senate's committee schedule XML. The placeholder entry for a day with nothing scheduled is skipped. */
export function parseSenateSchedule(xml: string): Hearing[] {
  const out: Hearing[] = [];
  const re = /<meeting>([\s\S]*?)<\/meeting>/g;
  let m: RegExpExecArray | null;
  const tag = (block: string, name: string): string => {
    const t = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
    return t ? plainText(t[1]) : '';
  };
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const committee = tag(block, 'committee');
    const date = tag(block, 'date_iso_8601');
    if (!committee || !date) continue;
    const docs = [...block.matchAll(/document_description="([^"]*)"/g)].map((d) => decodeEntities(d[1]).trim()).filter(Boolean);
    const sub = tag(block, 'sub_cmte');
    out.push({
      date,
      time: tag(block, 'time'),
      committee: sub ? `${committee}: ${sub}` : committee,
      type: tag(block, 'type'),
      room: tag(block, 'room'),
      matter: tag(block, 'matter') || docs.join('; '),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.time) - clockMinutes(b.time));
}

/** "02:00 PM" or "14:00:00" -> minutes after midnight, for sorting. Unreadable times sort last. */
export function clockMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(time.trim());
  if (!m) return 24 * 60;
  let h = Number(m[1]);
  const half = m[3]?.toUpperCase();
  if (half === 'PM' && h < 12) h += 12;
  if (half === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

const committees: CardDef = {
  id: 'macro.congress-committees',
  title: 'Committee Calendar',
  source: 'U.S. Senate',
  description: 'Scheduled Senate committee hearings and meetings.',
  async run(ctx) {
    const xml = await ctx.http.text('https://www.senate.gov/general/committee_schedules/hearings.xml', { source: 'U.S. Senate', ttl: 3600 });
    const hearings = parseSenateSchedule(xml);
    if (!hearings.length) {
      if (/<css_meetings_scheduled>/.test(xml)) return { blocks: [{ kind: 'text', text: 'No Senate committee hearings are scheduled.' }], sourceUrl: 'https://www.senate.gov/committees/hearings_meetings.htm', asOf: isoDate(ctx.now()) };
      throw new SourceError('U.S. Senate', 'the committee schedule could not be read');
    }
    return {
      blocks: [
        {
          kind: 'table',
          columns: [{ key: 'date', label: 'Date' }, { key: 'time', label: 'Time (ET)' }, { key: 'committee', label: 'Committee', maxWidth: 44 }, { key: 'type', label: 'Type', maxWidth: 20 }, { key: 'room', label: 'Room' }, { key: 'matter', label: 'Matter', maxWidth: 90 }],
          rows: hearings.slice(0, 40).map((h) => ({ ...h })),
        },
      ],
      sourceUrl: 'https://www.senate.gov/committees/hearings_meetings.htm',
      asOf: isoDate(ctx.now()),
      notes: ['Senate committees only. The House publishes its committee calendar on a site that refuses automated readers, and the Congress.gov API lists House meetings without their subject.'],
    };
  },
};

interface Agency {
  agency_name?: string;
  abbreviation?: string;
  active_fy?: string;
  active_fq?: string;
  budget_authority_amount?: number;
  obligated_amount?: number;
  outlay_amount?: number;
  percentage_of_total_budget_authority?: number;
}

const SPENDING_URL = 'https://www.usaspending.gov/';

const agencies: CardDef = {
  id: 'macro.spending-agencies',
  title: 'Spending by Agency',
  source: 'USAspending.gov',
  description: 'Budgetary resources, obligations and outlays of the largest federal agencies for the current fiscal year.',
  async run(ctx) {
    const body = await ctx.http.json<{ results?: Agency[] }>('https://api.usaspending.gov/api/v2/references/toptier_agencies/', { source: 'USAspending', ttl: 21600, timeoutMs: 40_000 });
    const list = (body.results ?? []).filter((a) => typeof a.budget_authority_amount === 'number' && (a.budget_authority_amount as number) > 0).sort((a, b) => (b.budget_authority_amount as number) - (a.budget_authority_amount as number));
    if (!list.length) throw new SourceError('USAspending', 'no agencies returned');
    const fy = list[0].active_fy ?? '';
    const rows: Row[] = list.slice(0, 30).map((a) => ({
      agency: a.agency_name ?? '',
      abbr: a.abbreviation ?? '',
      resources: a.budget_authority_amount ?? null,
      obligated: a.obligated_amount ?? null,
      outlays: a.outlay_amount ?? null,
      used: a.budget_authority_amount ? ((a.obligated_amount ?? 0) / a.budget_authority_amount) * 100 : null,
      share: typeof a.percentage_of_total_budget_authority === 'number' ? a.percentage_of_total_budget_authority * 100 : null,
    }));
    return {
      blocks: [
        {
          kind: 'table',
          title: `Fiscal year ${fy}${list[0].active_fq ? `, through quarter ${list[0].active_fq}` : ''}`,
          columns: [
            { key: 'agency', label: 'Agency', maxWidth: 46 },
            { key: 'abbr', label: 'Abbr' },
            { key: 'resources', label: 'Budgetary resources', format: 'usdCompact' },
            { key: 'obligated', label: 'Obligated', format: 'usdCompact' },
            { key: 'outlays', label: 'Outlays', format: 'usdCompact' },
            { key: 'used', label: 'Obligated %', format: 'pct', digits: 1 },
            { key: 'share', label: 'Share of total', format: 'pct', digits: 1 },
          ],
          rows,
          footnote: `The ${rows.length} largest of ${list.length} agencies by budgetary resources.`,
        },
      ],
      sourceUrl: `${SPENDING_URL}agency`,
      asOf: fy ? `FY${fy}` : undefined,
      notes: ['Budgetary resources are what an agency may spend this year, including amounts carried over. Obligations are commitments made; outlays are cash paid. Agencies report monthly, about a month in arrears.'],
    };
  },
};

interface Award {
  'Award ID'?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number;
  'Awarding Agency'?: string;
  'Start Date'?: string;
  Description?: string;
  generated_internal_id?: string;
}

const awards: CardDef = {
  id: 'macro.spending-awards',
  title: 'Largest New Contract Awards',
  source: 'USAspending.gov',
  description: 'The largest federal contracts first awarded in the last 90 days, optionally matching a keyword.',
  params: [{ name: 'query', label: 'Keyword', default: '', hint: 'e.g. shipbuilding, cloud, vaccine; empty shows all' }],
  async run(ctx, p) {
    const end = ctx.now();
    const start = new Date(end.getTime() - 90 * 86_400_000);
    const q = (p.query ?? '').trim();
    if (q && q.length < 3) throw new SourceError('USAspending', 'the keyword must have at least three characters');
    const filters: Record<string, unknown> = {
      award_type_codes: ['A', 'B', 'C', 'D'],
      time_period: [{ start_date: isoDate(start), end_date: isoDate(end), date_type: 'new_awards_only' }],
    };
    if (q) filters.keywords = [q];
    const body = await ctx.http.json<{ results?: Award[] }>('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      source: 'USAspending',
      ttl: 3600,
      timeoutMs: 45_000,
      method: 'POST',
      body: { filters, fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'], sort: 'Award Amount', order: 'desc', limit: 30, page: 1 },
    });
    const rows: Row[] = (body.results ?? []).map((a) => ({
      start: a['Start Date'] ?? null,
      recipient: a['Recipient Name'] ?? '',
      amount: a['Award Amount'] ?? null,
      agency: a['Awarding Agency'] ?? '',
      description: (a.Description ?? '').replace(/\s+/g, ' ').trim(),
      award: a['Award ID'] ?? '',
      link: a.generated_internal_id ? `${SPENDING_URL}award/${a.generated_internal_id}` : '',
    }));
    if (!rows.length) throw new SourceError('USAspending', q ? `no new contract awards match "${q}" in the last 90 days` : 'no new contract awards returned');
    return {
      blocks: [
        {
          kind: 'table',
          title: `Contracts first awarded ${isoDate(start)} to ${isoDate(end)}${q ? ` matching "${q}"` : ''}`,
          columns: [{ key: 'start', label: 'Work starts' }, { key: 'recipient', label: 'Recipient', maxWidth: 38 }, { key: 'amount', label: 'Award amount', format: 'usdCompact' }, { key: 'agency', label: 'Agency', maxWidth: 30 }, { key: 'description', label: 'Description', maxWidth: 60 }, { key: 'link', label: 'Link', maxWidth: 40 }],
          rows,
        },
      ],
      sourceUrl: `${SPENDING_URL}search`,
      asOf: isoDate(end),
      notes: ['Award amount is the total obligated on the contract so far, not its ceiling. Work starts is the first day of the period of performance, which can precede the signing date. Defense contracts are published with a 90-day delay, so recent Pentagon awards are missing.'],
    };
  },
};

/** The most recently completed U.S. fiscal year (1 October to 30 September, named for the year it ends in). */
export function lastCompleteFiscalYear(now: Date): number {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

const recipients: CardDef = {
  id: 'macro.spending-recipients',
  title: 'Top Recipients',
  source: 'USAspending.gov',
  description: 'The recipients of the most federal award money (contracts, grants, loans and direct payments) in a fiscal year.',
  params: [{ name: 'fy', label: 'Fiscal year', default: '', hint: 'e.g. 2026; empty = the latest completed fiscal year' }],
  async run(ctx, p) {
    const latest = lastCompleteFiscalYear(ctx.now());
    const fy = p.fy && p.fy.trim() ? Number(p.fy) : latest;
    if (!Number.isInteger(fy) || fy < 2008 || fy > latest + 1) throw new SourceError('USAspending', `fiscal year must be between 2008 and ${latest + 1}`);
    const body = await ctx.http.json<{ results?: { name?: string; amount?: number; uei?: string | null; recipient_id?: string | null }[] }>('https://api.usaspending.gov/api/v2/search/spending_by_category/recipient/', {
      source: 'USAspending',
      ttl: 21600,
      timeoutMs: 45_000,
      method: 'POST',
      body: { filters: { time_period: [{ start_date: `${fy - 1}-10-01`, end_date: `${fy}-09-30` }] }, category: 'recipient', limit: 31, page: 1 },
    });
    const list = body.results ?? [];
    if (!list.length) throw new SourceError('USAspending', `no recipients returned for fiscal year ${fy}`);
    const named = list.filter((r) => r.recipient_id);
    const pooled = list.find((r) => !r.recipient_id);
    const rows: Row[] = named.slice(0, 30).map((r, i) => ({ rank: i + 1, recipient: r.name ?? '', amount: r.amount ?? null, uei: r.uei ?? '', link: `${SPENDING_URL}recipient/${r.recipient_id}/${fy}` }));
    const notes = ['Obligations on all award types in the fiscal year (1 October to 30 September). State agencies rank highly because Medicaid and other grants flow through them.'];
    if (pooled?.amount) notes.push(`Not ranked: ${pooled.name ?? 'pooled recipients'} (${(pooled.amount / 1e12).toFixed(2)} trillion dollars), the aggregate for payments to individuals such as Social Security and Medicare.`);
    return {
      blocks: [{ kind: 'table', title: `Fiscal year ${fy}`, columns: [{ key: 'rank', label: '#', format: 'int' }, { key: 'recipient', label: 'Recipient', maxWidth: 60 }, { key: 'amount', label: 'Obligations', format: 'usdCompact' }, { key: 'uei', label: 'UEI' }, { key: 'link', label: 'Link', maxWidth: 40 }], rows }],
      sourceUrl: `${SPENDING_URL}recipient`,
      asOf: `FY${fy}`,
      notes,
    };
  },
};

export const governmentCards: CardDef[] = [bills, laws, votes, members, committees, agencies, awards, recipients];

export const governmentDashboards: DashboardDef[] = [
  {
    id: 'congress',
    title: 'U.S. Congress',
    group: 'Government & Regulation',
    tabs: [
      { id: 'bills', title: 'Bills', cards: ['macro.congress-bills'] },
      { id: 'laws', title: 'Laws', cards: ['macro.congress-laws'] },
      { id: 'votes', title: 'Votes', cards: ['macro.congress-votes'] },
      { id: 'members', title: 'Members', cards: ['macro.congress-members'] },
      { id: 'committees', title: 'Committees', cards: ['macro.congress-committees'] },
    ],
  },
  {
    id: 'spending',
    title: 'Federal Spending',
    group: 'Government & Regulation',
    tabs: [
      { id: 'agencies', title: 'Agencies', cards: ['macro.spending-agencies'] },
      { id: 'awards', title: 'Awards', cards: ['macro.spending-awards'] },
      { id: 'recipients', title: 'Recipients', cards: ['macro.spending-recipients'] },
    ],
  },
];
