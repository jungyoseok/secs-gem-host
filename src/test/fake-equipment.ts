import net from 'node:net';
import fs from 'node:fs';
import {
  item, encodeItem, decodeItem, encodeHeader, decodePacket, type SecsItem,
} from '../codec.js';
import { loadModel, svItem, type Model } from '../model.js';

/** Every knob makes exactly one startup step answer wrong. */
export type Knobs = {
  commack?: number;   // S1F14 COMMACK
  onlack?: number;    // S1F18 ONLACK
  drack?: number;     // S2F34 DRACK
  lrack?: number;     // S2F36 LRACK
  erack?: number;     // S2F38 ERACK
  ackc5?: number;     // S5F4 ACKC5
  tiack?: number;     // S2F32 TIACK
  delayMs?: number;   // delay every reply, to push it past T3
  sendS9?: number;    // push S9F<n> right after Select
  s1f4NotList?: boolean;   // S1F4 body is not a list
  s1f12Empty?: boolean;    // S1F12 namelist is empty
  s2f30NotList?: boolean;  // S2F30 body is not a list
  silentOn?: string;       // never answer this "S<n>F<n>", to force a T3 expiry
};

export class FakeEquipment {
  port = 0;
  /** Every data message this equipment received, as "S<n>F<n>" — lets a test prove a reconnect. */
  seen: string[] = [];
  /** Last decoded body per "S<n>F<n>", so a test can assert what the host actually sent. */
  bodies: Record<string, SecsItem | null> = {};
  private srv: net.Server | null = null;
  private sock: net.Socket | null = null;
  private sessionId = 0;
  private sys = 5000;

  constructor(private knobs: Knobs = {}, private model: Model = loadModel()) {}

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(sock => this.attach(sock));
      this.srv = srv;
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        this.port = (srv.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    this.sock?.destroy();
    this.sock = null;
    return new Promise(resolve => {
      if (!this.srv) return resolve();
      this.srv.close(() => resolve());
      this.srv = null;
    });
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    sock.setNoDelay(true);
    let acc = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', d => {
      acc = Buffer.concat([acc, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
      for (;;) {
        if (acc.length < 4) break;
        const len = acc.readUInt32BE(0);
        if (acc.length < 4 + len) break;
        const frame = acc.subarray(0, 4 + len);
        acc = acc.subarray(4 + len);
        this.onFrame(frame);
      }
    });
  }

  private onFrame(frame: Buffer): void {
    const p = decodePacket(frame);
    if (!p) return;
    if (p.stype === 1) {                                  // Select.req
      this.sessionId = p.sessionId;
      this.write(encodeHeader(p.sessionId, 0, 0, 0, 2, p.systemBytes));
      if (this.knobs.sendS9) {
        const fn = this.knobs.sendS9;
        setTimeout(() => this.push(9, fn, item('B', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 20);
      }
      return;
    }
    if (p.stype === 5) { this.write(encodeHeader(p.sessionId, 0, 0, 0, 6, p.systemBytes)); return; }
    if (p.stype === 9) { this.sock?.destroy(); return; }
    if (p.stype !== 0) return;
    const sf = `S${p.stream}F${p.function}`;
    this.seen.push(sf);

    let body: SecsItem | null = null;
    if (p.body.length) { try { body = decodeItem(p.body).item; } catch { body = null; } }
    this.bodies[sf] = body;
    if (this.knobs.silentOn === sf) return;
    const rsp = this.answer(p.stream, p.function, body);
    if (!rsp || !p.wbit) return;
    const emit = () => this.write(encodeHeader(p.sessionId, p.stream, rsp.func, 0, 0, p.systemBytes, encodeItem(rsp.body)));
    if (this.knobs.delayMs) setTimeout(emit, this.knobs.delayMs);
    else emit();
  }

  private answer(s: number, f: number, _body: SecsItem | null): { func: number; body: SecsItem } | null {
    const k = this.knobs;
    const m = this.model;
    const ack = (n: number) => item('B', [n]);
    if (s === 1 && f === 1) {
      return { func: 2, body: item('L', undefined, [item('A', m.mdln), item('A', m.softrev)]) };
    }
    if (s === 1 && f === 13) {
      return {
        func: 14,
        body: item('L', undefined, [
          ack(k.commack ?? 0),
          item('L', undefined, [item('A', m.mdln), item('A', m.softrev)]),
        ]),
      };
    }
    if (s === 1 && f === 17) return { func: 18, body: ack(k.onlack ?? 0) };
    if (s === 1 && f === 3) {
      if (k.s1f4NotList) return { func: 4, body: item('A', 'not a list') };
      return { func: 4, body: item('L', undefined, m.svs.map(sv => svItem(sv) as SecsItem)) };
    }
    if (s === 1 && f === 11) {
      if (k.s1f12Empty) return { func: 12, body: item('L', undefined, []) };
      return {
        func: 12,
        body: item('L', undefined, m.svs.map(sv => item('L', undefined, [
          item('U4', [sv.id]), item('A', sv.name), item('A', sv.units),
        ]))),
      };
    }
    if (s === 2 && f === 29) {
      if (k.s2f30NotList) return { func: 30, body: item('A', 'not a list') };
      return {
        func: 30,
        body: item('L', undefined, [item('L', undefined, [
          item('U4', [1]), item('A', 'EC_1'), item('A', '0'), item('A', '100'), item('A', '50'), item('A', ''),
        ])]),
      };
    }
    if (s === 2 && f === 33) return { func: 34, body: ack(k.drack ?? 0) };
    if (s === 2 && f === 35) return { func: 36, body: ack(k.lrack ?? 0) };
    if (s === 2 && f === 37) return { func: 38, body: ack(k.erack ?? 0) };
    if (s === 5 && f === 3) {
      // E5: a zero-length ALID item means "all alarms"; any ALID we don't have is ACKC5 1.
      const alids = (_body?.children?.[1]?.value as number[] | undefined) ?? [];
      const known = alids.every(a => m.alarms.some(x => x.alid === Number(a)));
      return { func: 4, body: ack(k.ackc5 ?? (known ? 0 : 1)) };
    }
    if (s === 2 && f === 31) return { func: 32, body: ack(k.tiack ?? 0) };
    if (s === 2 && f === 41) {
      return { func: 42, body: item('L', undefined, [ack(0), item('L', undefined, [])]) };
    }
    return null;
  }

  /** S6F11: L[ DATAID, CEID, L[ L[ RPTID, L[ V... ] ] ] ] */
  sendS6F11(ceid: number, rptid: number, values: SecsItem[]): void {
    this.push(6, 11, item('L', undefined, [
      item('U4', [1]),
      item('U4', [ceid]),
      item('L', undefined, [
        item('L', undefined, [item('U4', [rptid]), item('L', undefined, values)]),
      ]),
    ]), true);
  }

  /** S1F1 from the equipment side: "are you there?", answered by the host's S1F2. */
  sendS1F1(): void { this.push(1, 1, item('L', undefined, []), true); }

  /** S1F13 from the equipment side: the equipment opens communication itself. */
  sendS1F13(): void {
    this.push(1, 13, item('L', undefined, [item('A', this.model.mdln), item('A', this.model.softrev)]), true);
  }

  /** S5F1: L[ ALCD, ALID, ALTX ] */
  sendS5F1(alid: number, text: string): void {
    this.push(5, 1, item('L', undefined, [
      item('B', [0x80]), item('U4', [alid]), item('A', text),
    ]), true);
  }

  /** Emit `rows` samples from a trace as S6F11 reports, one every dsperMs. */
  replayTrace(trace: Trace, ceid: number, rptid: number, rows = trace.rows.length): void {
    trace.rows.slice(0, rows).forEach((row, n) => {
      const values = row.map((raw, i) => traceValue(trace.types[i], raw));
      const emit = () => this.sendS6F11(ceid, rptid, values);
      if (n === 0) emit();
      else setTimeout(emit, n * trace.dsperMs).unref?.();
    });
  }

  /** Send any primary with an arbitrary session id — used to provoke the host's S9F1. */
  pushAs(sessionId: number, stream: number, func: number, body: SecsItem): void {
    this.write(encodeHeader(sessionId, stream, func, 0, 0, ++this.sys, encodeItem(body), true));
  }

  private push(stream: number, func: number, body: SecsItem, wbit = false): void {
    this.write(encodeHeader(this.sessionId, stream, func, 0, 0, ++this.sys, encodeItem(body), wbit));
  }

  private write(b: Buffer): void { this.sock?.write(b); }
}

export type Trace = {
  trid: number;
  dsperMs: number;
  totsmp: number;
  repgsz: number;
  types: string[];
  vids: number[];
  rows: string[][];
};

/** fixtures/traces/ sits two levels above dist/test/. */
export function loadTrace(name: string): Trace {
  const src = fs.readFileSync(new URL(`../../fixtures/traces/${name}`, import.meta.url), 'utf8');
  const lines = src.split(/\r?\n/).filter(l => l.trim().length > 0).map(l => l.replace(/,\s*$/, '').split(','));
  const [meta, types, vids, ...rows] = lines;
  return {
    trid: Number(meta[0]),
    dsperMs: Number(meta[1]),
    totsmp: Number(meta[2]),
    repgsz: Number(meta[3]),
    types,
    vids: vids.map(Number),
    rows: rows.map(r => r.slice(1)),
  };
}

function traceValue(type: string, raw: string): SecsItem {
  return type === 'A' ? item('A', raw) : item(type, [Number(raw)]);
}
