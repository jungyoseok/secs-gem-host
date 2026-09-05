import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEquipment } from './fake-equipment.js';
import { Hsms } from '../hsms.js';
import { item } from '../codec.js';
import { loadModel } from '../model.js';

test('the default model has the Kystem numbering scheme with generic names', () => {
  const m = loadModel();
  assert.equal(m.mdln, 'GENERIC-1');
  assert.ok(m.svs.some(s => s.id === 1));
  assert.ok(m.svs.some(s => s.id >= 101 && s.id < 1000));
  assert.ok(m.svs.some(s => s.id >= 10000));
  assert.ok(m.alarms.every(a => a.alid >= 1001));
  assert.ok(m.events.length > 0 && m.reports.length > 0);
  const json = JSON.stringify(m);
  for (const banned of ['LG', 'Foxconn', 'Simmtech', 'MoldPress', 'SEMV', 'SEMB', 'HP1']) {
    assert.ok(!json.includes(banned), `model leaks "${banned}"`);
  }
});

test('the fake answers the whole E30 startup correctly', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const h = new Hsms({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await h.connect();
  assert.equal(h.state, 'SELECTED');

  const s1f14 = await h.send(1, 13, true, item('L', undefined, [item('A', 'GEMHOST'), item('A', '0.1.0')]));
  assert.equal(s1f14!.function, 14);
  assert.deepEqual(s1f14!.body!.children![0], { type: 'B', value: [0] });

  const s1f18 = await h.send(1, 17, true, null);
  assert.deepEqual(s1f18!.body, { type: 'B', value: [0] });

  const s1f4 = await h.send(1, 3, true, item('L', undefined, []));
  assert.equal(s1f4!.body!.type, 'L');
  assert.ok(s1f4!.body!.children!.length > 0);

  const s1f12 = await h.send(1, 11, true, item('L', undefined, []));
  assert.ok(s1f12!.body!.children!.length > 0);

  const s2f30 = await h.send(2, 29, true, item('L', undefined, []));
  assert.equal(s2f30!.body!.type, 'L');

  const s2f34 = await h.send(2, 33, true, item('L', undefined, [item('U4', [1]), item('L', undefined, [])]));
  assert.deepEqual(s2f34!.body, { type: 'B', value: [0] });

  const s2f36 = await h.send(2, 35, true, item('L', undefined, [item('U4', [1]), item('L', undefined, [])]));
  assert.deepEqual(s2f36!.body, { type: 'B', value: [0] });

  const s2f38 = await h.send(2, 37, true, item('L', undefined, [item('BOOLEAN', [true]), item('L', undefined, [])]));
  assert.deepEqual(s2f38!.body, { type: 'B', value: [0] });

  const s5f4 = await h.send(5, 3, true, item('L', undefined, [item('B', [0x80]), item('U4', [0])]));
  assert.deepEqual(s5f4!.body, { type: 'B', value: [0] });

  const s2f32 = await h.send(2, 31, true, item('A', '2026090512000000'));
  assert.deepEqual(s2f32!.body, { type: 'B', value: [0] });

  h.close();
  await eq.close();
});

test('knobs change the ack byte', async () => {
  const eq = new FakeEquipment({ commack: 1, drack: 3 });
  const port = await eq.listen();
  const h = new Hsms({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await h.connect();
  const s1f14 = await h.send(1, 13, true, item('L', undefined, [item('A', 'GEMHOST'), item('A', '0.1.0')]));
  assert.deepEqual(s1f14!.body!.children![0], { type: 'B', value: [1] });
  const s2f34 = await h.send(2, 33, true, item('L', undefined, [item('U4', [1]), item('L', undefined, [])]));
  assert.deepEqual(s2f34!.body, { type: 'B', value: [3] });
  h.close();
  await eq.close();
});

test('sendS9 pushes an S9F5 after select', async () => {
  const eq = new FakeEquipment({ sendS9: 5 });
  const port = await eq.listen();
  const h = new Hsms({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  const got: number[] = [];
  h.on('message', m => { if (m.stream === 9) got.push(m.function); });
  await h.connect();
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(got, [5]);
  h.close();
  await eq.close();
});

test('sendS6F11 delivers a report the host can read', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const h = new Hsms({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  const seen: any[] = [];
  h.on('message', m => { if (m.stream === 6 && m.function === 11) seen.push(m.body); });
  await h.connect();
  eq.sendS6F11(10001, 10001, [item('A', 'IDLE'), item('U4', [7])]);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].children[1], { type: 'U4', value: [10001] });
  assert.deepEqual(seen[0].children[2].children[0].children[0], { type: 'U4', value: [10001] });
  h.close();
  await eq.close();
});
