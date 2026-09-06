import test from 'node:test';
import assert from 'node:assert/strict';
import { GemHost } from '../host.js';
import { FakeEquipment, type Knobs } from './fake-equipment.js';
import { item, type SecsItem } from '../codec.js';
import { loadModel } from '../model.js';

async function run(knobs: Knobs = {}, timers = {}) {
  const eq = new FakeEquipment(knobs);
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0, timers });
  await host.connect();
  const report = await host.startup();
  // The fake pushes its S9 20ms after Select, which can land after a fast startup has
  // already snapshotted its flags — settle, then read the live flag list.
  await new Promise(r => setTimeout(r, 60));
  const flags = host.status().flags;
  host.disconnect();
  await eq.close();
  return { ...report, flags };
}

test('a correct equipment passes all 10 steps', async () => {
  const r = await run();
  assert.equal(r.total, 10);
  assert.equal(r.passed, 10, JSON.stringify(r.rows.filter(x => x.result !== 'PASS'), null, 2));
  assert.deepEqual(r.rows.map(x => x.step), ['1','2','3','4','5','6','7','8','9','10']);
  assert.deepEqual(r.rows.map(x => x.sent), [
    'S1F13','S1F17','S1F3','S1F11','S2F29','S2F33','S2F35','S2F37','S5F3','S2F31',
  ]);
  assert.deepEqual(r.rows.map(x => x.got), [
    'S1F14','S1F18','S1F4','S1F12','S2F30','S2F34','S2F36','S2F38','S5F4','S2F32',
  ]);
  assert.ok(r.rows.every(x => x.limitMs === 45000));
  assert.deepEqual(r.flags, []);
});

const knobCases: [keyof Knobs, number, string][] = [
  ['commack', 1, '1'],
  ['onlack', 1, '2'],
  ['drack', 3, '6'],
  ['lrack', 4, '7'],
  ['erack', 1, '8'],
  ['ackc5', 1, '9'],
  ['tiack', 1, '10'],
];

for (const [knob, value, step] of knobCases) {
  test(`knob ${knob}=${value} fails exactly step ${step}`, async () => {
    const r = await run({ [knob]: value } as Knobs);
    const failed = r.rows.filter(x => x.result === 'FAIL').map(x => x.step);
    assert.deepEqual(failed, [step]);
    assert.equal(r.rows.find(x => x.step === step)!.ack, String(value));
    assert.equal(r.passed, 9);
  });
}

// Steps 3, 4 and 5 check the reply's shape, not an ack byte, so they need body knobs.
const bodyKnobCases: [keyof Knobs, string][] = [
  ['s1f4NotList', '3'],
  ['s1f12Empty', '4'],
  ['s2f30NotList', '5'],
];

for (const [knob, step] of bodyKnobCases) {
  test(`knob ${knob} fails exactly step ${step}`, async () => {
    const r = await run({ [knob]: true } as Knobs);
    const failed = r.rows.filter(x => x.result === 'FAIL').map(x => x.step);
    assert.deepEqual(failed, [step], JSON.stringify(r.rows, null, 2));
    assert.equal(r.passed, 9);
  });
}

test('a delayed equipment fails step 1 on T3 and raises a flag', async () => {
  const r = await run({ delayMs: 300 }, { t3: 0.15 });
  assert.equal(r.rows[0].result, 'FAIL');
  assert.match(r.rows[0].note, /T3/);
  assert.ok(r.flags.some(f => /reply outside T3/.test(f)), r.flags.join('|'));
});

test('an S9F5 from the equipment becomes a flag', async () => {
  const r = await run({ sendS9: 5 });
  assert.equal(r.passed, 10);
  assert.ok(r.flags.some(f => /S9F5 received/.test(f)), r.flags.join('|'));
});

test('host auto-replies to S1F1, S6F11 and S5F1, and queues the events', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  eq.sendS5F1(1001, 'ALARM_1001');
  await new Promise(r => setTimeout(r, 120));
  const events = host.drainEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => `S${e.stream}F${e.function}`), ['S6F11', 'S5F1']);
  assert.equal(host.drainEvents().length, 0);
  host.disconnect();
  await eq.close();
});

// Deviation from the brief: the brief asserted `reports.includes(10)`, which is already
// true from the test-driven first startup and so proved nothing. Only reports produced
// AFTER the marker count, and the replacement equipment must see a second S1F13.
test('reconnect re-runs the startup', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0, timers: { t5: 0.1 } });
  const reports: number[] = [];
  host.onReport = r => reports.push(r.passed);
  await host.connect();
  await host.startup();
  reports.push(-1); // marker: everything after this came from a reconnect
  host.autoReconnect(true);
  await eq.close();
  await new Promise(r => setTimeout(r, 50));
  const eq2 = new FakeEquipment();
  await eq2.listen(port);
  await new Promise(r => setTimeout(r, 800));
  const afterMarker = reports.slice(reports.indexOf(-1) + 1);
  assert.ok(afterMarker.includes(10), `expected a re-run report, got ${reports.join(',')}`);
  assert.ok(eq2.seen.includes('S1F13'), `replacement equipment saw ${eq2.seen.join(',')}`);
  host.autoReconnect(false);
  host.disconnect();
  await eq2.close();
});

/** Poll the fake's received-message log until `sf` has been seen `n` times. */
async function waitSeen(eq: FakeEquipment, sf: string, n: number, ms = 1000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (eq.seen.filter(x => x === sf).length >= n) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

test('equipment-initiated S1F13 establishes comm, so later events are not "unsolicited"', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  assert.equal(host.status().commEstablished, false);
  eq.sendS1F13();
  assert.ok(await waitSeen(eq, 'S1F14', 1), eq.seen.join(','));
  assert.equal(host.status().commEstablished, true);
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(host.status().flags.filter(f => /unsolicited/.test(f)), []);
  host.disconnect();
  await eq.close();
});

test('waitFor consumes: two waits take two events, and the queue is left empty', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();

  const live = host.waitFor('S6F11', { ceid: 10001, within: 1000 });   // waiter first
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'ONE' }]);
  const a = await live;
  assert.ok(a, 'live waitFor timed out');

  eq.sendS6F11(10001, 10002, [{ type: 'A', value: 'TWO' }]);           // event first
  await new Promise(r => setTimeout(r, 80));
  const b = await host.waitFor('S6F11', { ceid: 10001, within: 1000 });
  assert.ok(b, 'queued waitFor timed out');
  assert.notEqual(a!.systemBytes, b!.systemBytes, 'the second wait returned the first event again');
  assert.equal(host.drainEvents().length, 0);

  host.disconnect();
  await eq.close();
});

test('dropAckOnce skips exactly one S6F12, and the next event is acked', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  host.dropAckOnce('S6F11');
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(eq.seen.filter(x => x === 'S6F12').length, 0, eq.seen.join(','));
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  assert.ok(await waitSeen(eq, 'S6F12', 1), eq.seen.join(','));
  host.disconnect();
  await eq.close();
});

test('sleepBeforeReply delays the next reply', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  host.sleepBeforeReply(200);
  const t0 = Date.now();
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  assert.ok(await waitSeen(eq, 'S6F12', 1), eq.seen.join(','));
  const slow = Date.now() - t0;
  assert.ok(slow >= 180, `expected a delayed ack, got ${slow}ms`);

  const t1 = Date.now();                                   // the delay is once-only
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  assert.ok(await waitSeen(eq, 'S6F12', 2), eq.seen.join(','));
  assert.ok(Date.now() - t1 < 150, 'the delay did not clear after one reply');

  host.disconnect();
  await eq.close();
});

test('startup on a link that is not selected fails step 1 and skips the rest', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await eq.close();                                        // link drops before startup
  await new Promise(r => setTimeout(r, 50));
  const r = await host.startup();
  assert.equal(r.passed, 0);
  assert.equal(r.total, 10);
  assert.equal(r.rows[0].result, 'FAIL');
  assert.equal(r.rows[0].note, 'HSMS not selected');
  assert.deepEqual([...new Set(r.rows.slice(1).map(x => x.result))], ['SKIP']);
  host.disconnect();
});


test('the host answers S1F1 with a zero-length list, not its own MDLN/SOFTREV', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  eq.sendS1F1();
  assert.ok(await waitSeen(eq, 'S1F2', 1), eq.seen.join(','));
  assert.deepEqual(eq.bodies['S1F2'], { type: 'L', children: [] });
  host.disconnect();
  await eq.close();
});

test('a T3 expiry sends S9F9 carrying the timed-out primary\'s MHEAD', async () => {
  const eq = new FakeEquipment({ silentOn: 'S1F17' });
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0, timers: { t3: 0.2 } });
  await host.connect();
  await host.startup();
  assert.ok(await waitSeen(eq, 'S9F9', 1), eq.seen.join(','));
  const b = eq.bodies['S9F9'] as SecsItem;
  assert.equal(b.type, 'B');
  const bytes = b.value as number[];
  assert.equal(bytes.length, 10);
  assert.equal(bytes[2] & 0x7f, 1, 'MHEAD stream');
  assert.equal(bytes[3], 17, 'MHEAD function');
  host.disconnect();
  await eq.close();
});

test('a data message with a foreign session id gets S9F1 and is not processed', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  eq.pushAs(7, 6, 11, item('L', undefined, [
    item('U4', [1]), item('U4', [10001]), item('L', undefined, []),
  ]));
  assert.ok(await waitSeen(eq, 'S9F1', 1), eq.seen.join(','));
  assert.equal(eq.seen.filter(x => x === 'S6F12').length, 0, eq.seen.join(','));
  assert.equal(host.drainEvents().length, 0);
  assert.ok(host.status().flags.some(f => /unrecognised device id 7/.test(f)), host.status().flags.join('|'));
  host.disconnect();
  await eq.close();
});

test('the S2F33 and S2F35 bodies match the model', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  const m = loadModel();

  assert.deepEqual(eq.bodies['S2F33'], {
    type: 'L',
    children: [
      { type: 'U4', value: [1] },
      { type: 'L', children: m.reports.map(r => ({
        type: 'L',
        children: [
          { type: 'U4', value: [r.rptid] },
          { type: 'L', children: r.vids.map(v => ({ type: 'U4', value: [v] })) },
        ],
      })) },
    ],
  });

  assert.deepEqual(eq.bodies['S2F35'], {
    type: 'L',
    children: [
      { type: 'U4', value: [1] },
      { type: 'L', children: m.events.map(e => ({
        type: 'L',
        children: [
          { type: 'U4', value: [e.ceid] },
          { type: 'L', children: e.rptids.map(r => ({ type: 'U4', value: [r] })) },
        ],
      })) },
    ],
  });

  host.disconnect();
  await eq.close();
});

test('step 9 sends a zero-length ALID item ("all alarms"), not ALID 0', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  const r = await host.startup();
  host.disconnect();
  await eq.close();
  assert.deepEqual(eq.bodies['S5F3'], {
    type: 'L',
    children: [{ type: 'B', value: [0x80] }, { type: 'U4', value: [] }],
  });
  assert.equal(r.rows.find(x => x.step === '9')!.result, 'PASS');
});

test('an equipment whose SVIDs differ is flagged, and LRACK 4 says to pass --model', async () => {
  const base = loadModel();
  const eq = new FakeEquipment({ lrack: 4 }, {
    ...base,
    svs: base.svs.map(sv => ({ ...sv, id: sv.id + 500000 })),
  });
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  const r = await host.startup();
  host.disconnect();
  await eq.close();
  assert.ok(host.lastSvids.length > 0);
  assert.ok(r.flags.some(f => /^model VIDs not in equipment SVID list: 10001, 10002/.test(f)), r.flags.join('|'));
  const row = r.rows.find(x => x.step === '7')!;
  assert.match(row.note, /^LRACK 4 — CEID\/VID not defined at the equipment; pass --model <file> with the equipment's own IDs$/);
});

async function runState(knobs: Knobs = {}) {
  const eq = new FakeEquipment(knobs);
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  const report = await host.stateReport();
  host.disconnect();
  await eq.close();
  return report;
}

test('a state-aware equipment passes all 6 state steps', async () => {
  const r = await runState({ stateAware: true });
  assert.equal(r.total, 6);
  assert.equal(r.passed, 6, JSON.stringify(r.rows.filter(x => x.result !== 'PASS'), null, 2));
  assert.deepEqual(r.rows.map(x => x.sent), ['S1F1', 'S1F13', 'S1F1', 'S2F41', 'S1F17', 'S2F41']);
  assert.deepEqual(r.rows.map(x => x.got), ['S1F0', 'S1F14', 'S1F2', 'S2F42', 'S1F18', 'S2F42']);
  assert.equal(r.rows[3].ack, '2');
  assert.equal(r.rows[5].ack, '0');
});

test('an equipment that ignores state fails step 1 and step 4', async () => {
  const r = await runState();
  const failed = r.rows.filter(x => x.result === 'FAIL');
  assert.deepEqual(failed.map(x => x.step), ['1', '4'], JSON.stringify(r.rows, null, 2));
  assert.equal(failed[0].got, 'S1F2');
  assert.match(failed[1].note, /already ON-LINE REMOTE/);
  assert.equal(r.passed, 4);
});
