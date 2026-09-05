import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { FakeEquipment, type Knobs } from './fake-equipment.js';

const CLI = new URL('../cli.js', import.meta.url).pathname;

function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', code => resolve({ code: code ?? -1, out, err }));
  });
}

test('connect --report against a correct equipment exits 0 with 10 rows', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const r = await runCli(['connect', `127.0.0.1:${port}`, '--report', '--linktest', '0']);
  await eq.close();
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /E30 startup: 10\/10 passed/);
  assert.match(r.out, /^1 {4}S1F13 {3}S1F14 {3}S1F14 {3}0 {4}\d+\/45000\s+PASS/m);
  assert.equal((r.out.match(/^\d+ {3,4}S\d/gm) ?? []).length, 10);
});

test('connect --report against a wrong equipment exits 1 and names the step', async () => {
  const knobs: Knobs = { erack: 1 };
  const eq = new FakeEquipment(knobs);
  const port = await eq.listen();
  const r = await runCli(['connect', `127.0.0.1:${port}`, '--report', '--linktest', '0']);
  await eq.close();
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^8 {4}S2F37 {3}S2F38 {3}S2F38 {3}1 {4}\d+\/45000\s+FAIL {4}ERACK 1$/m);
  assert.match(r.out, /E30 startup: 9\/10 passed/);
});

test('--t3 is read in seconds', async () => {
  const eq = new FakeEquipment({ delayMs: 400 });
  const port = await eq.listen();
  const r = await runCli(['connect', `127.0.0.1:${port}`, '--report', '--linktest', '0', '--t3', '0.2']);
  await eq.close();
  assert.equal(r.code, 1);
  assert.match(r.out, /\/200\s+FAIL/);
});

test('a bad target is a clean error, not a stack trace', async () => {
  const r = await runCli(['connect', 'nonsense']);
  assert.equal(r.code, 2);
  assert.match(r.err, /expected <host:port>/);
});
