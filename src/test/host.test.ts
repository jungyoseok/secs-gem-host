import test from 'node:test';
import assert from 'node:assert/strict';
import { GemHost } from '../host.js';
import { FakeEquipment, type Knobs } from './fake-equipment.js';

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
