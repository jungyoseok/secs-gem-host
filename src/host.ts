import { Hsms, DEFAULT_TIMERS, type HsmsMessage, type HsmsTimers } from './hsms.js';
import { loadModel, type Model } from './model.js';
import { item, secsText, type SecsItem } from './codec.js';

export type ReportRow = {
  step: string;
  sent: string;
  expected: string;
  got: string;
  ack: string;
  elapsedMs: number;
  limitMs: number;
  result: 'PASS' | 'FAIL' | 'SKIP';
  note: string;
};

export type Report = { rows: ReportRow[]; passed: number; total: number; flags: string[] };

/** Appended to the ack notes that mean "the equipment has never heard of these ids". */
const MODEL_HINT = ' — CEID/VID not defined at the equipment; pass --model <file> with the equipment\'s own IDs';

export type GemHostOptions = {
  host: string;
  port: number;
  deviceId?: number;
  passive?: boolean;
  timers?: Partial<HsmsTimers>;
  linktestSec?: number;
  model?: Model;
  onLog?: (line: string) => void;
};

/** GEM host identity announced in S1F13/S1F14/S1F2. */
const HOST_MDLN = 'GEMHOST';
const HOST_SOFTREV = '0.1.0';

/** Unref'd: a pending T5 backoff must never hold the process open after disconnect(). */
const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms).unref(); });

/** First B item found at the top of a body, which is where every GEM ack code lives. */
function ackByte(m: HsmsMessage | null): number | null {
  const b = m?.body;
  if (!b) return null;
  if (b.type === 'B' && Array.isArray(b.value)) return b.value[0] ?? null;
  if (b.type === 'L' && b.children?.[0]?.type === 'B') return (b.children[0].value as number[])[0] ?? null;
  return null;
}

/** CEID out of an S6F11 body: L[ DATAID, CEID, L[...] ]. */
export function ceidOf(m: HsmsMessage): number | null {
  const c = m.body?.children;
  if (!c || c.length < 2) return null;
  const v = c[1].value;
  return Array.isArray(v) ? Number(v[0]) : Number(v);
}

/** S1F12 namelist: L[ L[ SVID, SVNAME, UNITS ] ]. */
export function svidsOf(m: HsmsMessage): { id: number; name: string; units: string }[] {
  return (m.body?.children ?? []).map(c => {
    const [id, name, units] = c.children ?? [];
    const v = id?.value;
    return {
      id: Number(Array.isArray(v) ? v[0] : v),
      name: String(name?.value ?? ''),
      units: String(units?.value ?? ''),
    };
  }).filter(s => Number.isFinite(s.id));
}

/** SECS-II 16-char timestamp, YYYYMMDDhhmmsscc. */
function timeNow(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(Math.floor(d.getMilliseconds() / 10))}`;
}

type StepSpec = {
  step: string;
  sent: string;
  expected: string;
  stream: number;
  func: number;
  expectFunc: number;
  body: (m: Model) => SecsItem | null;
  /** Optional preamble sent in the same step; its ack is only noted, never fatal. */
  pre?: (m: Model) => SecsItem | null;
  check: (rsp: HsmsMessage) => { ok: boolean; note: string };
};

const STEPS: StepSpec[] = [
  {
    step: '1', sent: 'S1F13', expected: 'S1F14', stream: 1, func: 13, expectFunc: 14,
    body: () => item('L', undefined, [item('A', HOST_MDLN), item('A', HOST_SOFTREV)]),
    check: rsp => {
      const a = ackByte(rsp);
      const names = rsp.body?.children?.[1]?.children ?? [];
      if (a !== 0) return { ok: false, note: `COMMACK ${a}` };
      if (names.length < 2) return { ok: false, note: 'MDLN/SOFTREV missing' };
      return { ok: true, note: `${names[0].value}/${names[1].value}` };
    },
  },
  {
    step: '2', sent: 'S1F17', expected: 'S1F18', stream: 1, func: 17, expectFunc: 18,
    body: () => null,
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 || a === 2 ? { ok: true, note: '' } : { ok: false, note: `ONLACK ${a}` };
    },
  },
  {
    step: '3', sent: 'S1F3', expected: 'S1F4', stream: 1, func: 3, expectFunc: 4,
    body: () => item('L', undefined, []),
    check: rsp => rsp.body?.type === 'L'
      ? { ok: true, note: `${rsp.body.children!.length} values` }
      : { ok: false, note: `body is ${rsp.body?.type ?? 'empty'}, expected L` },
  },
  {
    step: '4', sent: 'S1F11', expected: 'S1F12', stream: 1, func: 11, expectFunc: 12,
    body: () => item('L', undefined, []),
    check: rsp => {
      const n = rsp.body?.type === 'L' ? rsp.body.children!.length : -1;
      return n > 0 ? { ok: true, note: `${n} SVIDs` } : { ok: false, note: 'empty SVID namelist' };
    },
  },
  {
    step: '5', sent: 'S2F29', expected: 'S2F30', stream: 2, func: 29, expectFunc: 30,
    body: () => item('L', undefined, []),
    check: rsp => rsp.body?.type === 'L'
      ? { ok: true, note: `${rsp.body.children!.length} ECs` }
      : { ok: false, note: `body is ${rsp.body?.type ?? 'empty'}, expected L` },
  },
  {
    step: '6', sent: 'S2F33', expected: 'S2F34', stream: 2, func: 33, expectFunc: 34,
    // Delete every existing report first, then define ours.
    pre: () => item('L', undefined, [item('U4', [1]), item('L', undefined, [])]),
    body: m => item('L', undefined, [
      item('U4', [1]),
      item('L', undefined, m.reports.map(r => item('L', undefined, [
        item('U4', [r.rptid]),
        item('L', undefined, r.vids.map(v => item('U4', [v]))),
      ]))),
    ]),
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 ? { ok: true, note: '' } : { ok: false, note: `DRACK ${a}${a === 4 ? MODEL_HINT : ''}` };
    },
  },
  {
    step: '7', sent: 'S2F35', expected: 'S2F36', stream: 2, func: 35, expectFunc: 36,
    body: m => item('L', undefined, [
      item('U4', [1]),
      item('L', undefined, m.events.map(e => item('L', undefined, [
        item('U4', [e.ceid]),
        item('L', undefined, e.rptids.map(r => item('U4', [r]))),
      ]))),
    ]),
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 ? { ok: true, note: '' } : { ok: false, note: `LRACK ${a}${a === 4 ? MODEL_HINT : ''}` };
    },
  },
  {
    step: '8', sent: 'S2F37', expected: 'S2F38', stream: 2, func: 37, expectFunc: 38,
    // CEED true with an empty CEID list means "enable them all".
    body: () => item('L', undefined, [item('BOOLEAN', [true]), item('L', undefined, [])]),
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 ? { ok: true, note: '' } : { ok: false, note: `ERACK ${a}${a === 1 ? MODEL_HINT : ''}` };
    },
  },
  {
    step: '9', sent: 'S5F3', expected: 'S5F4', stream: 5, func: 3, expectFunc: 4,
    // ALED bit 7 set = enable; E5: a ZERO-LENGTH ALID item means "all alarms" (not ALID 0).
    body: () => item('L', undefined, [item('B', [0x80]), item('U4', [])]),
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 ? { ok: true, note: '' } : { ok: false, note: `ACKC5 ${a}` };
    },
  },
  {
    step: '10', sent: 'S2F31', expected: 'S2F32', stream: 2, func: 31, expectFunc: 32,
    body: () => item('A', timeNow()),
    check: rsp => {
      const a = ackByte(rsp);
      return a === 0 ? { ok: true, note: '' } : { ok: false, note: `TIACK ${a}` };
    },
  },
];

export class GemHost {
  readonly model: Model;
  /** SVIDs the equipment listed in S1F12 (step 4), so steps 6-8 can explain a DRACK/LRACK. */
  lastSvids: { id: number; name: string; units: string }[] = [];
  onReport?: (r: Report) => void;

  private opts: GemHostOptions;
  private hsms: Hsms | null = null;
  private events: HsmsMessage[] = [];
  private flags: string[] = [];
  private commEstablished = false;
  private dropNext = new Set<string>();
  private replyDelayMs = 0;
  private reconnecting = false;
  private looping = false;
  private waiters: { sf: string; ceid?: number; resolve: (m: HsmsMessage) => void }[] = [];
  /** 10-byte header of the last primary we sent, so a T3 expiry can quote it in S9F9's MHEAD. */
  private lastPrimaryHeader: Buffer | null = null;

  constructor(opts: GemHostOptions) {
    this.opts = opts;
    this.model = opts.model ?? loadModel();
  }

  private log(line: string): void { this.opts.onLog?.(line); }

  async connect(): Promise<void> {
    const h = new Hsms({
      host: this.opts.host, port: this.opts.port, deviceId: this.opts.deviceId ?? 0,
      passive: this.opts.passive, timers: this.opts.timers, linktestSec: this.opts.linktestSec,
    });
    this.hsms = h;
    h.on('anomaly', a => this.flag(a));
    h.on('tx', m => {
      if (m.wbit) this.lastPrimaryHeader = Buffer.from(m.raw.subarray(4, 14));
      this.log(`${new Date().toISOString()} H→E S${m.stream}F${m.function}${m.wbit ? ' W' : ''} sys=${m.systemBytes}\n${m.body ? secsText(m.body) : '<empty>'}`);
    });
    h.on('rx', m => {
      if (m.stype !== 0) return;
      this.log(`${new Date().toISOString()} E→H S${m.stream}F${m.function}${m.wbit ? ' W' : ''} sys=${m.systemBytes}\n${m.body ? secsText(m.body) : '<empty>'}`);
    });
    h.on('message', m => this.onPrimary(m));
    h.on('close', () => { if (this.reconnecting) void this.reconnectLoop(); });
    await h.connect();
  }

  private flag(f: string): void { if (!this.flags.includes(f)) this.flags.push(f); }

  /** Host-side auto replies + event queue + conformance flags. */
  private onPrimary(m: HsmsMessage): void {
    const sf = `S${m.stream}F${m.function}`;
    if (this.hsms && m.sessionId !== this.hsms.deviceId) {
      // E5: an unrecognised device id is answered with S9F1 and nothing else.
      void this.hsms.send(9, 1, false, item('B', [...m.raw.subarray(4, 14)])).catch(() => {});
      this.flag(`unrecognised device id ${m.sessionId} on ${sf}`);
      return;
    }
    if (m.function % 2 === 0) {
      this.flag(`primary with even function ${sf}`);
      return;
    }
    if (!this.commEstablished && m.stream !== 1) {
      this.flag(`unsolicited ${sf} before S1F14`);
    }
    if (m.stream === 9) {
      this.flag(`${sf} received`);
      return;
    }
    // A waiter consumes the event: exactly one of waitFor() and drainEvents() ever sees it.
    const w = this.waiters.find(x => x.sf === sf && (x.ceid === undefined || ceidOf(m) === x.ceid));
    if (w) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(m);
    } else if ((m.stream === 6 && m.function === 11) || (m.stream === 5 && m.function === 1)) {
      this.events.push(m);
      if (this.events.length > 1000) this.events.shift();
    }
    if (!m.wbit) return;
    if (this.dropNext.delete(sf)) { this.log(`(dropped the reply to ${sf} on purpose)`); return; }

    const send = () => {
      const h = this.hsms;
      if (!h) return;
      if (m.stream === 1 && m.function === 13) {
        h.reply(m, 14, item('L', undefined, [item('B', [0]), item('L', undefined, [item('A', HOST_MDLN), item('A', HOST_SOFTREV)])]));
        // Comm is established either way round: the equipment may open it, not just startup().
        this.commEstablished = true;
      } else if (m.stream === 1 && m.function === 1) {
        // E5: the HOST's S1F2 is a zero-length list; MDLN/SOFTREV is the equipment's side.
        h.reply(m, 2, item('L', undefined, []));
      } else if (m.stream === 5 && m.function === 1) {
        h.reply(m, 2, item('B', [0]));
      } else if (m.stream === 6 && m.function === 11) {
        h.reply(m, 12, item('B', [0]));
      } else if (m.stream === 6 && m.function === 1) {
        h.reply(m, 2, item('B', [0]));
      } else {
        // Unknown function inside a known stream → S9F5, unknown stream → S9F3.
        const known = [1, 2, 5, 6, 9].includes(m.stream);
        void h.send(9, known ? 5 : 3, false, item('B', [...m.raw.subarray(4, 14)])).catch(() => {});
        this.flag(`answered ${sf} with S9F${known ? 5 : 3}`);
      }
    };
    if (this.replyDelayMs > 0) {
      const d = this.replyDelayMs;
      this.replyDelayMs = 0;
      setTimeout(send, d).unref();
    } else send();
  }

  async startup(): Promise<Report> {
    const h = this.hsms;
    if (!h) throw new Error('not connected: call connect() first');
    const limitMs = h.timers.t3 * 1000;
    const rows: ReportRow[] = [];
    this.commEstablished = false;
    this.flags = [];        // a Report's flags describe this startup, not the whole session

    for (const s of STEPS) {
      const row: ReportRow = {
        step: s.step, sent: s.sent, expected: s.expected, got: '-', ack: '-',
        elapsedMs: 0, limitMs, result: 'SKIP', note: '',
      };
      if (h.state !== 'SELECTED') {
        // The first step carries the failure so the report exits non-zero; the rest never ran.
        row.result = rows.length === 0 ? 'FAIL' : 'SKIP';
        row.note = 'HSMS not selected';
        rows.push(row);
        continue;
      }
      const t0 = Date.now();
      try {
        if (s.step === '6' && this.lastSvids.length) {
          const have = new Set(this.lastSvids.map(v => v.id));
          const miss = [...new Set(this.model.reports.flatMap(r => r.vids))].filter(v => !have.has(v));
          if (miss.length) this.flag(`model VIDs not in equipment SVID list: ${miss.join(', ')}`);
        }
        if (s.pre) {
          const preRsp = await h.send(s.stream, s.func, true, s.pre(this.model));
          const preAck = ackByte(preRsp);
          if (preAck !== 0) row.note = `delete-all ack ${preAck}; `;
        }
        const rsp = await h.send(s.stream, s.func, true, s.body(this.model));
        row.elapsedMs = Date.now() - t0;
        if (!rsp) { row.result = 'FAIL'; row.note += 'no reply'; rows.push(row); continue; }
        row.got = `S${rsp.stream}F${rsp.function}`;
        const a = ackByte(rsp);
        row.ack = a === null ? '-' : String(a);
        if (rsp.function !== s.expectFunc) {
          row.result = 'FAIL';
          row.note += `expected ${s.expected}`;
        } else {
          const c = s.check(rsp);
          row.result = c.ok ? 'PASS' : 'FAIL';
          row.note += c.note;
        }
        if (s.step === '1' && row.result === 'PASS') this.commEstablished = true;
        if (s.step === '4' && row.result === 'PASS') this.lastSvids = svidsOf(rsp);
      } catch (e) {
        row.elapsedMs = Date.now() - t0;
        row.result = 'FAIL';
        row.note += (e as Error).message;
        if (/T3/.test((e as Error).message)) {
          this.flag(`reply outside T3 on ${s.sent}`);
          // E30/E37: a transaction timer expiry is reported to the peer as S9F9.
          const mhead = this.lastPrimaryHeader ?? Buffer.alloc(10);
          try { await h.send(9, 9, false, item('B', [...mhead])); } catch { /* link may be down */ }
        }
      }
      rows.push(row);
    }

    const report: Report = {
      rows,
      passed: rows.filter(r => r.result === 'PASS').length,
      total: rows.length,
      flags: [...this.flags],
    };
    this.onReport?.(report);
    return report;
  }

  async send(stream: number, func: number, body: SecsItem | null, wbit = true): Promise<HsmsMessage | null> {
    if (!this.hsms) throw new Error('not connected');
    return this.hsms.send(stream, func, wbit, body);
  }

  waitFor(sf: string, opts: { ceid?: number; within?: number } = {}): Promise<HsmsMessage | null> {
    const i = this.events.findIndex(m => `S${m.stream}F${m.function}` === sf
      && (opts.ceid === undefined || ceidOf(m) === opts.ceid));
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    return new Promise(resolve => {
      const w = { sf, ceid: opts.ceid, resolve };
      this.waiters.push(w);
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, opts.within ?? 5000);
      t.unref();
    });
  }

  drainEvents(): HsmsMessage[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  status() {
    return {
      state: this.hsms?.state ?? 'NOT CONNECTED',
      connected: this.hsms?.state === 'SELECTED',
      commEstablished: this.commEstablished,
      queued: this.events.length,
      flags: [...this.flags],
    };
  }

  dropAckOnce(sf: string): void { this.dropNext.add(sf); }
  sleepBeforeReply(ms: number): void { this.replyDelayMs = ms; }

  autoReconnect(on: boolean): void { this.reconnecting = on; }

  private async reconnectLoop(): Promise<void> {
    if (this.looping) return;               // one loop only, however many 'close' events fire
    this.looping = true;
    const t5 = (this.opts.timers?.t5 ?? DEFAULT_TIMERS.t5) * 1000;
    try {
      while (this.reconnecting) {
        await sleep(t5);
        if (!this.reconnecting) return;
        try {
          this.hsms?.removeAllListeners();
          this.hsms?.close();
          await this.connect();
          await this.startup();
          return;
        } catch (e) {
          this.log(`reconnect failed: ${(e as Error).message}; retrying after T5`);
        }
      }
    } finally {
      this.looping = false;
    }
  }

  disconnect(): void {
    this.reconnecting = false;
    this.hsms?.separate();
    this.hsms?.close();
    this.hsms = null;
  }
}
