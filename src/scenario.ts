import { GemHost, ceidOf } from './host.js';
import { secsText, type SecsItem } from './codec.js';

export type ScenarioStep =
  | { send: string; body?: SecsItem | null }
  | { expect: string; ceid?: number; within?: number }
  | { wait: number }
  | { 'drop-ack': string }
  | { 'sleep-t3': boolean };

export type ScenarioRow = { n: number; step: string; result: 'PASS' | 'FAIL'; note: string };
export type ScenarioResult = { rows: ScenarioRow[]; passed: number; total: number };

export function parseSf(sf: string): { stream: number; function: number } {
  const m = /^s(\d+)f(\d+)$/i.exec(sf.trim());
  if (!m) throw new Error(`"${sf}" is not a stream/function like S6F11`);
  return { stream: Number(m[1]), function: Number(m[2]) };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function runScenario(host: GemHost, steps: ScenarioStep[]): Promise<ScenarioResult> {
  const rows: ScenarioRow[] = [];
  let n = 0;
  for (const s of steps) {
    n += 1;
    const label = JSON.stringify(s);
    try {
      if ('send' in s) {
        const { stream, function: fn } = parseSf(s.send);
        const wbit = fn % 2 === 1;
        const rsp = await host.send(stream, fn, s.body ?? null, wbit);
        const note = rsp
          ? `got S${rsp.stream}F${rsp.function}\n${rsp.body ? secsText(rsp.body) : '<empty>'}`
          : 'sent (no reply expected)';
        rows.push({ n, step: label, result: 'PASS', note });
      } else if ('expect' in s) {
        const got = await host.waitFor(s.expect.toUpperCase(), { ceid: s.ceid, within: s.within ?? 5000 });
        if (!got) {
          rows.push({ n, step: label, result: 'FAIL', note: `nothing arrived within ${s.within ?? 5000} ms` });
        } else {
          const c = ceidOf(got);
          rows.push({ n, step: label, result: 'PASS', note: c === null ? '' : `CEID ${c}` });
        }
      } else if ('wait' in s) {
        await sleep(s.wait);
        rows.push({ n, step: label, result: 'PASS', note: '' });
      } else if ('drop-ack' in s) {
        host.dropAckOnce(s['drop-ack'].toUpperCase());
        rows.push({ n, step: label, result: 'PASS', note: 'next ack will be dropped' });
      } else if ('sleep-t3' in s && s['sleep-t3']) {
        host.sleepBeforeReply(46_000);
        rows.push({ n, step: label, result: 'PASS', note: 'next reply delayed past T3' });
      } else {
        rows.push({ n, step: label, result: 'FAIL', note: 'unknown scenario step' });
      }
    } catch (e) {
      rows.push({ n, step: label, result: 'FAIL', note: (e as Error).message });
    }
  }
  return { rows, passed: rows.filter(r => r.result === 'PASS').length, total: rows.length };
}

export function renderScenario(r: ScenarioResult): string {
  return [
    ...r.rows.map(x => `${String(x.n).padEnd(4)}${x.result.padEnd(6)}${x.step}${x.note ? `\n      ${x.note.replace(/\n/g, '\n      ')}` : ''}`),
    `scenario: ${r.passed}/${r.total} passed`,
  ].join('\n');
}
