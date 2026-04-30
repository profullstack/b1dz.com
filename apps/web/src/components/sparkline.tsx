/**
 * Inline price sparkline rendered via the Datatype variable font.
 * Syntax: `{l:v1,v2,...}` where each v is 0–100. The font ligatures
 * substitute the literal text with a chart glyph at render time.
 *
 * Color reflects profit/loss when `profitable` is provided; otherwise
 * falls back to last-vs-first direction for the rare caller that has
 * no PnL signal.
 */
export function Sparkline({
  samples,
  profitable,
  width = 60,
}: {
  samples?: number[];
  profitable?: boolean;
  width?: number;
}) {
  if (!samples || samples.length < 2) {
    return <span className="text-zinc-700">—</span>;
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min;
  const normalized = range === 0
    ? samples.map(() => 50)
    : samples.map((v) => Math.round(((v - min) / range) * 100));
  const isWin = profitable ?? samples[samples.length - 1] >= samples[0];
  const colorClass = isWin ? 'text-emerald-400' : 'text-red-400';
  return (
    <span
      className={`datatype-chart ${colorClass} inline-block`}
      style={{ minWidth: width, fontSize: '1.4em', lineHeight: 1 }}
    >
      {`{l:${normalized.join(',')}}`}
    </span>
  );
}
