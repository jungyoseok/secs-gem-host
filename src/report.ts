import type { Report } from './host.js';

const W = [5, 8, 8, 8, 5, 12, 8];
const RULE = '-'.repeat(72);

const row = (cells: string[]) =>
  cells.map((c, i) => (i < W.length ? c.padEnd(W[i]) : c)).join('').trimEnd();

export function renderReport(r: Report): string {
  return [
    row(['Step', 'Sent', 'Expect', 'Got', 'Ack', 'Time(ms)', 'Result', 'Note']),
    RULE,
    ...r.rows.map(x => row([
      x.step, x.sent, x.expected, x.got, x.ack, `${x.elapsedMs}/${x.limitMs}`, x.result, x.note,
    ])),
    RULE,
    `E30 startup: ${r.passed}/${r.total} passed`,
    ...r.flags.map(f => `flag: ${f}`),
  ].join('\n');
}

export function exitCode(r: Report): number {
  return r.rows.some(x => x.result === 'FAIL') ? 1 : 0;
}
