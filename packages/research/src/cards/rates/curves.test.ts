import { describe, expect, it } from 'vitest';
import {
  parseBoeCsv,
  parseEcbCurve,
  parseMofCsv,
  parseOecdRates,
  parseRiksbank,
  parseTesouro,
  parseTreasuryCsv,
  parseValet,
  tableToSeries,
  yearsBetween,
  yearsFor,
} from './curves.js';
import {
  bisArea,
  bpDiff,
  countryBy,
  curveAt,
  ecbPeriodDate,
  interpolate,
  latestDate,
  median,
  percentileRank,
  rangeStart,
  shiftBack,
  tenorLabel,
  tenorYears,
  valueAsOf,
  type TenorSeries,
} from './util.js';

describe('util', () => {
  it('shifts dates back by months and years with day clamping', () => {
    expect(shiftBack('2026-11-23', '1M')).toBe('2026-10-23');
    expect(shiftBack('2026-03-31', '1M')).toBe('2026-02-28');
    expect(shiftBack('2024-02-29', '1Y')).toBe('2023-02-28');
    expect(shiftBack('2026-01-15', '6M')).toBe('2025-07-15');
    expect(shiftBack('2026-11-23', '5Y')).toBe('2021-11-23');
  });

  it('resolves a range to a start date', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(rangeStart('2Y', now)).toBe('2024-11-24');
    expect(rangeStart('MAX', now, '1999-01-01')).toBe('1999-01-01');
    expect(rangeStart(undefined, now)).toBe('2025-11-24');
  });

  it('reads tenors from provider labels', () => {
    expect(tenorYears('1 Mo')).toBeCloseTo(1 / 12);
    expect(tenorYears('1.5 Month')).toBeCloseTo(0.125);
    expect(tenorYears('10 Yr')).toBe(10);
    expect(tenorYears('30 YR')).toBe(30);
    expect(tenorYears('SR_3M')).toBe(0.25);
    expect(tenorYears('SR_15Y')).toBe(15);
    expect(tenorYears('40Y')).toBe(40);
    expect(tenorYears('Date')).toBeNull();
    expect(tenorLabel(0.25)).toBe('3M');
    expect(tenorLabel(0.125)).toBe('1.5M');
    expect(tenorLabel(10)).toBe('10Y');
  });

  it('finds the value on or before a date, within a staleness limit', () => {
    const pts: [string, number][] = [
      ['2026-11-18', 4.1],
      ['2026-11-19', 4.2],
      ['2026-11-23', 4.3],
    ];
    expect(valueAsOf(pts, '2026-11-22')).toEqual({ date: '2026-11-19', value: 4.2 });
    expect(valueAsOf(pts, '2026-11-23')?.value).toBe(4.3);
    expect(valueAsOf(pts, '2026-11-17')).toBeNull();
    expect(valueAsOf(pts, '2026-12-20')).toBeNull();
    expect(valueAsOf(pts, '2026-12-20', 40)?.value).toBe(4.3);
  });

  it('builds a curve for a date and reports the newest date used', () => {
    const series: TenorSeries[] = [
      { label: '3M', years: 0.25, points: [['2026-11-17', 2.66]] },
      { label: '2Y', years: 2, points: [['2026-11-19', 3.3], ['2026-11-20', 3.19]] },
      { label: '50Y', years: 50, points: [['2020-01-02', 1]] },
    ];
    expect(latestDate(series)).toBe('2026-11-20');
    expect(curveAt(series, '2026-11-20')).toEqual({ values: [2.66, 3.19, null], date: '2026-11-20' });
    expect(curveAt(series, '2026-11-19').values).toEqual([2.66, 3.3, null]);
  });

  it('interpolates inside the knots only', () => {
    const knots: [number, number][] = [[1, 10], [3, 14], [5, 15]];
    expect(interpolate(knots, 2)).toBe(12);
    expect(interpolate(knots, 5)).toBe(15);
    expect(interpolate(knots, 0.5)).toBeNull();
    expect(interpolate(knots, 7)).toBeNull();
    expect(interpolate([], 1)).toBeNull();
  });

  it('computes basis points, percentile rank and median', () => {
    expect(bpDiff(4.92, 5.0)).toBe(-8);
    expect(bpDiff(4.37, 4.22)).toBe(15);
    expect(bpDiff(null, 1)).toBeNull();
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(75);
    expect(percentileRank([], 3)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('dates ECB weeks to their Friday', () => {
    // ISO week 46 of 2026 runs Monday 9 November to Sunday 15 November.
    expect(ecbPeriodDate('2026-W46')).toBe('2026-11-13');
    expect(ecbPeriodDate('2026-W01')).toBe('2026-01-02');
    expect(ecbPeriodDate('2026-10')).toBe('2026-10-01');
    expect(ecbPeriodDate('2026-11-23')).toBe('2026-11-23');
  });

  it('maps country codes, including the euro area', () => {
    expect(countryBy('gb')?.name).toBe('United Kingdom');
    expect(countryBy('UK')?.iso2).toBe('GB');
    expect(countryBy('DEU')?.iso2).toBe('DE');
    expect(countryBy('EA20')?.iso2).toBe('EA');
    expect(countryBy('XM')?.iso2).toBe('EA');
    expect(countryBy('ZZ')).toBeUndefined();
    expect(bisArea('DE')).toBe('XM');
    expect(bisArea('EA')).toBe('XM');
    expect(bisArea('SE')).toBe('SE');
  });
});

describe('U.S. Treasury CSV', () => {
  const csv = 'Date,"1 Mo","3 Mo","2 Yr","10 Yr"\n11/23/2026,4.20,4.37,4.63,4.92\n11/20/2026,4.19,4.32,4.63,\n';

  it('parses rows oldest first with blanks as null', () => {
    const t = parseTreasuryCsv(csv);
    expect(t.columns).toEqual(['1 Mo', '3 Mo', '2 Yr', '10 Yr']);
    expect(t.rows.map((r) => r.date)).toEqual(['2026-11-20', '2026-11-23']);
    expect(t.rows[0].values).toEqual([4.19, 4.32, 4.63, null]);
  });

  it('turns maturity columns into tenor series', () => {
    const s = tableToSeries(parseTreasuryCsv(csv));
    expect(s.map((x) => x.label)).toEqual(['1M', '3M', '2Y', '10Y']);
    expect(s[3].points).toEqual([['2026-11-23', 4.92]]);
    expect(s[2].points).toHaveLength(2);
  });

  it('ignores a file with no data rows', () => {
    expect(parseTreasuryCsv('Date,"1 Mo"\n').rows).toEqual([]);
    expect(parseTreasuryCsv('').columns).toEqual([]);
  });

  it('picks the year files that hold the requested dates', () => {
    expect(yearsFor(['2026-11-24', '2025-11-24']).sort()).toEqual([2025, 2026]);
    expect(yearsFor(['2026-01-05']).sort()).toEqual([2025, 2026]);
    expect(yearsBetween('2024-10-24', '2026-11-24')).toEqual([2024, 2025, 2026]);
  });
});

describe('ECB yield curve CSV', () => {
  it('splits AAA and all-issuer curves and sorts by maturity', () => {
    const csv = [
      'KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE',
      'YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_10Y,2026-11-23,3.3209069064',
      'YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M,B,U2,EUR,4F,G_N_A,SV_C_YM,SR_3M,2026-11-23,2.6848662295',
      'YC.B.U2.EUR.4F.G_N_C.SV_C_YM.SR_10Y,B,U2,EUR,4F,G_N_C,SV_C_YM,SR_10Y,2026-11-23,3.934521455',
    ].join('\n');
    const got = parseEcbCurve(csv);
    expect(got.get('G_N_A')?.map((s) => s.label)).toEqual(['3M', '10Y']);
    expect(got.get('G_N_A')?.[1].points[0]).toEqual(['2026-11-23', 3.3209069064]);
    expect(got.get('G_N_C')?.[0].years).toBe(10);
  });
});

describe('Bank of England CSV', () => {
  it('parses dates and series columns', () => {
    const got = parseBoeCsv('DATE,IUDSNPY,IUDMNPY\n01 Oct 2026,4.9132,5.3665\n02 Oct 2026,4.8917,\n');
    expect(got.get('IUDSNPY')).toEqual([['2026-10-01', 4.9132], ['2026-10-02', 4.8917]]);
    expect(got.get('IUDMNPY')).toEqual([['2026-10-01', 5.3665]]);
  });

  it('returns nothing for an error page', () => {
    expect(parseBoeCsv('<!DOCTYPE html><html><title>Error</title></html>').size).toBe(0);
  });
});

describe('Japan MoF CSV', () => {
  it('skips the title line and treats "-" as missing', () => {
    const csv = 'Interest Rate (November 2026),,,(Unit : %)\nDate,1Y,10Y,40Y\n2026/11/2,1.671,2.817,3.96\n2026/11/4,1.676,2.855,-\n,,,\n"note",,,\n';
    const s = parseMofCsv(csv);
    expect(s.map((x) => x.label)).toEqual(['1Y', '10Y', '40Y']);
    expect(s[0].points).toEqual([['2026-11-02', 1.671], ['2026-11-04', 1.676]]);
    expect(s[2].points).toEqual([['2026-11-02', 3.96]]);
  });
});

describe('Bank of Canada Valet', () => {
  it('reads observations per series and skips empty cells', () => {
    const got = parseValet({
      observations: [
        { d: '2026-11-19', 'BD.CDN.2YR.DQ.YLD': { v: '3.30' }, 'BD.CDN.10YR.DQ.YLD': { v: '3.81' } },
        { d: '2026-11-18', 'BD.CDN.2YR.DQ.YLD': { v: '3.28' }, 'BD.CDN.10YR.DQ.YLD': {} },
      ],
    });
    expect(got.get('BD.CDN.2YR.DQ.YLD')).toEqual([['2026-11-18', 3.28], ['2026-11-19', 3.3]]);
    expect(got.get('BD.CDN.10YR.DQ.YLD')).toEqual([['2026-11-19', 3.81]]);
  });
});

describe('Riksbank observations', () => {
  it('groups by series and sorts by date', () => {
    const got = parseRiksbank([
      { seriesId: 'SEGVB10YC', date: '2026-11-17', value: 3.107 },
      { seriesId: 'SEGVB10YC', date: '2026-11-16', value: 3.11 },
      { seriesId: 'SEGVB2YC', date: '2026-11-16', value: 2.652 },
      { seriesId: 'SEGVB2YC', date: '2026-11-17' },
    ]);
    expect(got.get('SEGVB10YC')).toEqual([['2026-11-16', 3.11], ['2026-11-17', 3.107]]);
    expect(got.get('SEGVB2YC')).toHaveLength(1);
  });
});

describe('Tesouro Direto CSV', () => {
  const csv = [
    'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
    'Tesouro Selic;01/03/2027;19/11/2026;0,03;0,04;20343,78;20332,84;20332,84',
    'Tesouro Prefixado;19/11/2027;19/11/2026;14,00;14,12;861,03;859,57;859,57',
    'Tesouro Prefixado com Juros Semestrais;19/11/2030;19/11/2026;15,00;15,12;957,56;955,17;955,17',
    'Tesouro Prefixado;19/11/2027;19/11/2020;7,00;7,12;600,00;599,00;599,00',
    'Tesouro IPCA+;15/05/2035;19/11/2026;7,50;7,62;2000,00;1999,00;1999,00',
  ].join('\n');

  it('interpolates fixed-rate bonds onto standard tenors and ignores other bond types', () => {
    const s = parseTesouro(csv, '2026-01-01', [1, 2, 3, 5]);
    expect(s.map((x) => x.label)).toEqual(['1Y', '2Y', '3Y']);
    expect(s[0].points[0][0]).toBe('2026-11-19');
    expect(s[0].points[0][1]).toBeCloseTo(14, 1);
    // Bonds at about 1 and 4 years: 2Y and 3Y sit a third and two thirds of the way; 5Y is beyond the last bond.
    expect(s[1].points[0][1]).toBeCloseTo(14.33, 1);
    expect(s[2].points[0][1]).toBeCloseTo(14.67, 1);
  });

  it('drops rows before the cut-off date', () => {
    const s = parseTesouro(csv, '2026-01-01', [1]);
    expect(s[0].points).toHaveLength(1);
  });
});

describe('OECD monthly rates CSV', () => {
  it('separates long and short rates by country', () => {
    const csv = [
      'DATAFLOW,REF_AREA,FREQ,MEASURE,UNIT_MEASURE,ACTIVITY,ADJUSTMENT,TRANSFORMATION,TIME_HORIZ,METHODOLOGY,TIME_PERIOD,OBS_VALUE,OBS_STATUS,UNIT_MULT,DECIMALS,BASE_PER',
      'OECD.SDD.STES:DSD_STES@DF_FINMARK(4.0),USA,M,IR3TIB,PA,_Z,_Z,_Z,_Z,N,2026-10,4.12,A,0,2,',
      'OECD.SDD.STES:DSD_STES@DF_FINMARK(4.0),USA,M,IRLT,PA,_Z,_Z,_Z,_Z,N,2026-10,5.13,A,0,2,',
      'OECD.SDD.STES:DSD_STES@DF_FINMARK(4.0),USA,M,IRLT,PA,_Z,_Z,_Z,_Z,N,2026-09,4.99,A,0,2,',
      'OECD.SDD.STES:DSD_STES@DF_FINMARK(4.0),DEU,M,IRLT,PA,_Z,_Z,_Z,_Z,N,2026-10,,M,0,2,',
    ].join('\n');
    const got = parseOecdRates(csv);
    expect(got.long.get('USA')).toEqual([['2026-09', 4.99], ['2026-10', 5.13]]);
    expect(got.short.get('USA')).toEqual([['2026-10', 4.12]]);
    expect(got.long.has('DEU')).toBe(false);
  });
});
