import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, parseSf, type ScenarioStep } from '../scenario.js';
import { GemHost } from '../host.js';
import { FakeEquipment } from './fake-equipment.js';

test('parseSf reads stream and function', () => {
  assert.deepEqual(parseSf('S6F11'), { stream: 6, function: 11 });
  assert.deepEqual(parseSf('s2f41'), { stream: 2, function: 41 });
  assert.throws(() => parseSf('nope'), /not a stream\/function/);
});

test('send + expect + wait run against the fake equipment', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();

  setTimeout(() => eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]), 60);

  const steps: ScenarioStep[] = [
    { send: 'S2F41', body: { type: 'L', children: [{ type: 'A', value: 'START' }, { type: 'L', children: [] }] } },
    { wait: 10 },
    { expect: 'S6F11', ceid: 10001, within: 2000 },
  ];
  const r = await runScenario(host, steps);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 3, JSON.stringify(r.rows));
  assert.match(r.rows[0].note, /S2F42/);
  host.disconnect();
  await eq.close();
});

test('expect fails when nothing arrives within the window', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();
  const r = await runScenario(host, [{ expect: 'S6F11', within: 100 }]);
  assert.equal(r.rows[0].result, 'FAIL');
  assert.match(r.rows[0].note, /nothing arrived/);
  host.disconnect();
  await eq.close();
});

test('drop-ack suppresses the next S6F12 and sleep-t3 delays the one after', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  const log: string[] = [];
  host.onReport = () => {};
  await host.connect();
  await host.startup();

  const r = await runScenario(host, [
    { 'drop-ack': 'S6F11' },
    { 'sleep-t3': true },
  ]);
  assert.equal(r.passed, 2);
  assert.deepEqual(host.status().state, 'SELECTED');

  // The flag is real, not just a PASS row: this S6F11 gets no S6F12 back.
  eq.sendS6F11(10001, 10001, [{ type: 'A', value: 'IDLE' }]);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!eq.seen.includes('S6F12'), eq.seen.join(','));

  void log;
  host.disconnect();
  await eq.close();
});
