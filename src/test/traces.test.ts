import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeEquipment, loadTrace } from './fake-equipment.js';
import { GemHost, ceidOf } from '../host.js';

test('fixtures carry no customer identifiers', () => {
  const dir = new URL('../../fixtures/traces/', import.meta.url);
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 3, `expected 3 trace fixtures, found ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const banned of ['LG', 'Foxconn', 'Simmtech', 'MoldPress', 'SEMV', 'SEMB', 'HP1', 'SECSGEM.']) {
      assert.ok(!src.includes(banned), `${f} leaks "${banned}"`);
    }
    assert.ok(!/63\d{16}/.test(src), `${f} still has .NET tick timestamps`);
  }
});

test('loadTrace parses the four-block CSV', () => {
  const t = loadTrace('trace-1.csv');
  assert.equal(t.trid, 101);
  assert.ok(t.dsperMs > 0);
  assert.equal(t.types.length, t.vids.length);
  assert.ok(t.rows.length > 0);
  assert.equal(t.rows[0].length, t.vids.length);
  assert.deepEqual(t.vids, t.vids.map((_, i) => 10001 + i));
});

test('replaying a trace delivers S6F11 with the right RPTID and VIDs', async () => {
  const trace = loadTrace('trace-1.csv');
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const host = new GemHost({ host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 });
  await host.connect();
  await host.startup();

  eq.replayTrace(trace, 10002, 10002, 1);
  const got = await host.waitFor('S6F11', { ceid: 10002, within: 2000 });
  assert.ok(got, 'no S6F11 arrived');
  assert.equal(ceidOf(got!), 10002);
  const reports = got!.body!.children![2].children!;
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].children![0], { type: 'U4', value: [10002] });
  const values = reports[0].children![1].children!;
  assert.equal(values.length, trace.vids.length);
  assert.deepEqual(values.map(v => v.type), trace.types);

  host.disconnect();
  await eq.close();
});
