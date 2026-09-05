import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Hsms } from '../hsms.js';
import { item, encodeItem, encodeHeader, decodePacket, decodeItem } from '../codec.js';

/** Minimal peer: answers Select.req and Linktest.req, and S1F13 with S1F14. */
function peer(opts: { chunked?: boolean; silent?: boolean } = {}) {
  const srv = net.createServer(sock => {
    let acc = Buffer.alloc(0);
    sock.on('data', d => {
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 4) {
        const len = acc.readUInt32BE(0);
        if (acc.length < 4 + len) break;
        const frame = acc.subarray(0, 4 + len);
        acc = acc.subarray(4 + len);
        const p = decodePacket(frame)!;
        if (p.stype === 1) { sock.write(encodeHeader(p.sessionId, 0, 0, 0, 2, p.systemBytes)); continue; }
        if (p.stype === 5) { sock.write(encodeHeader(p.sessionId, 0, 0, 0, 6, p.systemBytes)); continue; }
        if (p.stype !== 0) continue;
        if (opts.silent) continue;
        if (p.stream === 1 && p.function === 13) {
          const body = encodeItem(item('L', undefined, [
            item('B', [0]),
            item('L', undefined, [item('A', 'FAKE'), item('A', '1.0')]),
          ]));
          const out = encodeHeader(p.sessionId, 1, 14, 0, 0, p.systemBytes, body);
          if (opts.chunked) { sock.write(out.subarray(0, 6)); setTimeout(() => sock.write(out.subarray(6)), 20); }
          else sock.write(out);
        }
      }
    });
  });
  return new Promise<{ port: number; close: () => void }>(res => {
    srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

test('active connect selects and exchanges S1F13/S1F14', async () => {
  const p = await peer();
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0 });
  await h.connect();
  assert.equal(h.state, 'SELECTED');
  const rsp = await h.send(1, 13, true, item('L', undefined, [item('A', 'HOST'), item('A', '0.1.0')]));
  assert.equal(rsp!.stream, 1);
  assert.equal(rsp!.function, 14);
  assert.equal(rsp!.body!.children![0].value[0], 0);
  h.close();
  p.close();
});

test('reassembles a reply split across TCP chunks', async () => {
  const p = await peer({ chunked: true });
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0 });
  await h.connect();
  const rsp = await h.send(1, 13, true, item('L', undefined, [item('A', 'HOST'), item('A', '0.1.0')]));
  assert.equal(rsp!.function, 14);
  h.close();
  p.close();
});

test('linktest completes within T6', async () => {
  const p = await peer();
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0 });
  await h.connect();
  await h.linktest();
  h.close();
  p.close();
});

test('a silent peer trips T3', async () => {
  const p = await peer({ silent: true });
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0, timers: { t3: 0.2 } });
  await h.connect();
  await assert.rejects(
    () => h.send(1, 13, true, item('L', undefined, [])),
    /T3 \(S1F13\) timeout/,
  );
  h.close();
  p.close();
});

test('passive listen accepts a Select.req from the equipment', async () => {
  const h = new Hsms({ host: '127.0.0.1', port: 0, passive: true, deviceId: 1, linktestSec: 0 });
  const connecting = h.connect();
  await new Promise(r => setTimeout(r, 30));
  const port = h.listeningPort!;
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.once('connect', r));
  sock.write(encodeHeader(1, 0, 0, 0, 1, 42));
  const rsp = await new Promise<Buffer>(r => sock.once('data', d => r(d as Buffer)));
  const p = decodePacket(rsp)!;
  assert.equal(p.stype, 2);
  assert.equal(p.function, 0);
  assert.equal(p.systemBytes, 42);
  await connecting;
  assert.equal(h.state, 'SELECTED');
  sock.destroy();
  h.close();
});

test('an unmatched even function raises a wrong-system-bytes anomaly', async () => {
  const p = await peer();
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0 });
  const seen: string[] = [];
  h.on('anomaly', a => seen.push(a));
  await h.connect();
  // Speak to the peer's socket directly is not possible here; instead feed the
  // reassembler by having the peer answer a request we never registered: send
  // S1F13 without the W-bit, so no pending entry exists for its system bytes.
  await h.send(1, 13, false, item('L', undefined, [item('A', 'HOST'), item('A', '0.1.0')]));
  await new Promise(r => setTimeout(r, 80));
  assert.ok(seen.some(s => /wrong system bytes on reply S1F14/.test(s)), seen.join('|'));
  h.close();
  p.close();
});

test('send() on a closed connection rejects at once instead of waiting out T3', async () => {
  const p = await peer();
  const h = new Hsms({ host: '127.0.0.1', port: p.port, deviceId: 1, linktestSec: 0 });
  await h.connect();
  h.close();
  await assert.rejects(
    () => Promise.race([
      h.send(1, 13, true, item('L', undefined, [])),
      new Promise((_, rj) => setTimeout(() => rj(new Error('hung past 500ms')), 500)),
    ]),
    /not connected/,
  );
  p.close();
});

test('a partial frame left by a dead socket does not corrupt the next connection', async () => {
  // One port, two behaviours: the first connection selects then dribbles half a
  // frame and stalls; the second behaves like the normal peer.
  let conns = 0;
  const srv = net.createServer(sock => {
    const first = conns++ === 0;
    let acc = Buffer.alloc(0);
    sock.on('data', d => {
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 4) {
        const len = acc.readUInt32BE(0);
        if (acc.length < 4 + len) break;
        const frame = acc.subarray(0, 4 + len);
        acc = acc.subarray(4 + len);
        const q = decodePacket(frame)!;
        if (q.stype === 1) {
          sock.write(encodeHeader(q.sessionId, 0, 0, 0, 2, q.systemBytes));
          // half a frame the host can never complete
          if (first) sock.write(encodeHeader(q.sessionId, 1, 14, 0, 0, 7).subarray(0, 6));
          continue;
        }
        if (q.stype === 0 && q.stream === 1 && q.function === 13) {
          const body = encodeItem(item('L', undefined, [item('B', [0])]));
          sock.write(encodeHeader(q.sessionId, 1, 14, 0, 0, q.systemBytes, body));
        }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;

  const h = new Hsms({ host: '127.0.0.1', port, deviceId: 1, linktestSec: 0, timers: { t3: 1, t6: 1 } });
  await h.connect();
  await new Promise(r => setTimeout(r, 40));   // let the half frame land in acc
  h.close();

  await h.connect();                            // same instance, fresh socket
  const rsp = await h.send(1, 13, true, item('L', undefined, []));
  assert.equal(rsp!.function, 14);
  assert.equal(rsp!.body!.children![0].value[0], 0);
  h.close();
  srv.close();
});
