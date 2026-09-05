import net from 'node:net';
import { EventEmitter } from 'node:events';
import { encodeItem, decodeItem, encodeHeader, decodePacket, type SecsItem } from './codec.js';

/** E37 defaults, in seconds. */
export type HsmsTimers = { t3: number; t5: number; t6: number; t7: number; t8: number };
export const DEFAULT_TIMERS: HsmsTimers = { t3: 45, t5: 10, t6: 5, t7: 10, t8: 5 };

export type HsmsMessage = {
  sessionId: number;
  stream: number;
  function: number;
  wbit: boolean;
  ptype: number;
  stype: number;
  systemBytes: number;
  body: SecsItem | null;
  raw: Buffer;
};

export type HsmsOptions = {
  host: string;
  port: number;
  deviceId?: number;
  passive?: boolean;
  timers?: Partial<HsmsTimers>;
  /** Linktest interval in seconds; 0 disables. Default 30. */
  linktestSec?: number;
};

type Pending = { resolve: (m: HsmsMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const MAX_FRAME = 8 * 1024 * 1024;

export class Hsms extends EventEmitter {
  readonly timers: HsmsTimers;
  readonly deviceId: number;
  state: 'NOT CONNECTED' | 'CONNECTED' | 'SELECTED' = 'NOT CONNECTED';
  /** Set once a passive listener is bound; useful when port 0 was requested. */
  listeningPort: number | null = null;

  private opts: HsmsOptions;
  private sock: net.Socket | null = null;
  private server: net.Server | null = null;
  private acc = Buffer.alloc(0);
  private sys = 0;
  private pending = new Map<number, Pending>();
  private linktestTimer: NodeJS.Timeout | null = null;
  private t8Timer: NodeJS.Timeout | null = null;

  constructor(opts: HsmsOptions) {
    super();
    this.opts = opts;
    this.deviceId = opts.deviceId ?? 0;
    this.timers = { ...DEFAULT_TIMERS, ...(opts.timers ?? {}) };
  }

  async connect(): Promise<void> {
    this.sock = this.opts.passive ? await this.accept() : await this.dial();
    this.attach(this.sock);
    this.state = 'CONNECTED';
    if (this.opts.passive) await this.awaitSelect();
    else await this.select();
    this.state = 'SELECTED';
    const iv = (this.opts.linktestSec ?? 30) * 1000;
    if (iv > 0) {
      this.linktestTimer = setInterval(() => {
        this.linktest().catch(e => this.emit('anomaly', `linktest failed: ${(e as Error).message}`));
      }, iv);
      this.linktestTimer.unref();
    }
  }

  private dial(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.opts.port, this.opts.host);
      const onErr = (e: Error) => reject(e);
      s.once('error', onErr);
      s.once('connect', () => { s.removeListener('error', onErr); resolve(s); });
    });
  }

  private accept(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      this.server = srv;
      srv.once('error', reject);
      srv.listen(this.opts.port, this.opts.host, () => {
        this.listeningPort = (srv.address() as net.AddressInfo).port;
        srv.once('connection', s => resolve(s));
      });
    });
  }

  private attach(s: net.Socket): void {
    s.setNoDelay(true);
    s.on('data', d => this.onData(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    s.on('error', e => this.emit('anomaly', `socket error: ${(e as Error).message}`));
    s.on('close', () => {
      this.state = 'NOT CONNECTED';
      this.clearTimers();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
      this.pending.clear();
      this.emit('close');
    });
  }

  private onData(d: Buffer): void {
    this.acc = Buffer.concat([this.acc, d]);
    for (;;) {
      if (this.acc.length < 4) break;
      const len = this.acc.readUInt32BE(0);
      if (len < 10 || len > MAX_FRAME) {
        this.emit('anomaly', `bad HSMS length field ${len}`);
        this.close();
        return;
      }
      if (this.acc.length < 4 + len) break;
      const frame = this.acc.subarray(0, 4 + len);
      this.acc = this.acc.subarray(4 + len);
      this.handle(frame);
    }
    if (this.t8Timer) { clearTimeout(this.t8Timer); this.t8Timer = null; }
    if (this.acc.length > 0) {
      this.t8Timer = setTimeout(() => {
        this.emit('anomaly', `T8 timeout: ${this.acc.length} bytes of a partial frame`);
        this.close();
      }, this.timers.t8 * 1000);
      this.t8Timer.unref();
    }
  }

  private handle(frame: Buffer): void {
    const d = decodePacket(frame);
    if (!d) return;
    let body: SecsItem | null = null;
    if (d.stype === 0 && d.body.length) {
      try { body = decodeItem(d.body).item; }
      catch (e) { this.emit('anomaly', `undecodable body on S${d.stream}F${d.function}: ${(e as Error).message}`); }
    }
    const m: HsmsMessage = {
      sessionId: d.sessionId, stream: d.stream, function: d.function, wbit: d.wbit,
      ptype: d.ptype, stype: d.stype, systemBytes: d.systemBytes, body, raw: frame,
    };
    this.emit('rx', m);
    if (m.stype !== 0) { this.control(m); return; }
    if (m.function % 2 === 0) {
      const p = this.pending.get(m.systemBytes);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.systemBytes);
        if (m.wbit) this.emit('anomaly', `W-bit set on reply S${m.stream}F${m.function}`);
        p.resolve(m);
        return;
      }
      this.emit('anomaly', `wrong system bytes on reply S${m.stream}F${m.function} sys=${m.systemBytes}`);
      this.emit('message', m);
      return;
    }
    this.emit('message', m);
  }

  private control(m: HsmsMessage): void {
    if (m.stype === 1) {                                    // Select.req
      this.write(encodeHeader(m.sessionId, 0, 0, 0, 2, m.systemBytes));
      this.state = 'SELECTED';
      this.emit('selected');
      return;
    }
    if (m.stype === 5) {                                    // Linktest.req
      this.write(encodeHeader(m.sessionId, 0, 0, 0, 6, m.systemBytes));
      return;
    }
    if (m.stype === 9) {                                    // Separate.req
      this.emit('separate');
      this.close();
      return;
    }
    const p = this.pending.get(m.systemBytes);              // 2 = Select.rsp, 6 = Linktest.rsp
    if (p) { clearTimeout(p.timer); this.pending.delete(m.systemBytes); p.resolve(m); }
  }

  private write(b: Buffer): void { this.sock?.write(b); }

  private nextSys(): number {
    this.sys = ((this.sys + 1) >>> 0) || 1;
    return this.sys;
  }

  private waitReply(sys: number, limitMs: number, label: string): Promise<HsmsMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sys);
        reject(new Error(`${label} timeout`));
      }, limitMs);
      this.pending.set(sys, { resolve, reject, timer });
    });
  }

  private async select(): Promise<void> {
    const sys = this.nextSys();
    this.write(encodeHeader(this.deviceId, 0, 0, 0, 1, sys));
    const rsp = await this.waitReply(sys, this.timers.t6 * 1000, 'T6 (Select.rsp)');
    if (rsp.stype !== 2) throw new Error(`expected Select.rsp, got SType ${rsp.stype}`);
    if (rsp.function !== 0) throw new Error(`Select.rsp status ${rsp.function}`);
  }

  private awaitSelect(): Promise<void> {
    if (this.state === 'SELECTED') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('T7 timeout: no Select.req from the equipment')), this.timers.t7 * 1000);
      t.unref();
      this.once('selected', () => { clearTimeout(t); resolve(); });
    });
  }

  async linktest(): Promise<void> {
    const sys = this.nextSys();
    this.write(encodeHeader(this.deviceId, 0, 0, 0, 5, sys));
    await this.waitReply(sys, this.timers.t6 * 1000, 'T6 (Linktest.rsp)');
  }

  async send(stream: number, func: number, wbit: boolean, body: SecsItem | null): Promise<HsmsMessage | null> {
    const sys = this.nextSys();
    const buf = body ? encodeItem(body) : Buffer.alloc(0);
    const frame = encodeHeader(this.deviceId, stream, func, 0, 0, sys, buf, wbit);
    const waiting = wbit ? this.waitReply(sys, this.timers.t3 * 1000, `T3 (S${stream}F${func})`) : null;
    this.write(frame);
    this.emit('tx', {
      sessionId: this.deviceId, stream, function: func, wbit, ptype: 0, stype: 0,
      systemBytes: sys, body, raw: frame,
    } as HsmsMessage);
    return waiting ? await waiting : null;
  }

  reply(to: HsmsMessage, func: number, body: SecsItem | null): void {
    const buf = body ? encodeItem(body) : Buffer.alloc(0);
    const frame = encodeHeader(to.sessionId, to.stream, func, 0, 0, to.systemBytes, buf, false);
    this.write(frame);
    this.emit('tx', {
      sessionId: to.sessionId, stream: to.stream, function: func, wbit: false, ptype: 0, stype: 0,
      systemBytes: to.systemBytes, body, raw: frame,
    } as HsmsMessage);
  }

  separate(): void {
    if (this.sock) this.write(encodeHeader(this.deviceId, 0, 0, 0, 9, this.nextSys()));
  }

  private clearTimers(): void {
    if (this.linktestTimer) { clearInterval(this.linktestTimer); this.linktestTimer = null; }
    if (this.t8Timer) { clearTimeout(this.t8Timer); this.t8Timer = null; }
  }

  close(): void {
    this.clearTimers();
    this.sock?.destroy();
    this.sock = null;
    this.server?.close();
    this.server = null;
    this.listeningPort = null;
    this.state = 'NOT CONNECTED';
  }
}
