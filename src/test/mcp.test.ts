import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { FakeEquipment } from './fake-equipment.js';

const CLI = new URL('../cli.js', import.meta.url).pathname;

class Rpc {
  private child: ChildProcessWithoutNullStreams;
  private queue: any[] = [];
  private waiters: ((m: any) => void)[] = [];
  constructor() {
    this.child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      const m = JSON.parse(line);
      const w = this.waiters.shift();
      if (w) w(m); else this.queue.push(m);
    });
  }
  send(msg: any) { this.child.stdin.write(`${JSON.stringify(msg)}\n`); }
  next(): Promise<any> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise(r => this.waiters.push(r));
  }
  async call(id: number, method: string, params: any) {
    this.send({ jsonrpc: '2.0', id, method, params });
    for (;;) { const m = await this.next(); if (m.id === id) return m; }
  }
  kill() { this.child.kill(); }
}

test('the MCP server lists its tools and runs the startup', async () => {
  const eq = new FakeEquipment();
  const port = await eq.listen();
  const rpc = new Rpc();

  const init = await rpc.call(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'secs-gem-host-test', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'secs-gem-host');
  rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await rpc.call(2, 'tools/list', {});
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ['connect', 'disconnect', 'events', 'send', 'startup', 'status']);

  const conn = await rpc.call(3, 'tools/call', {
    name: 'connect',
    arguments: { host: '127.0.0.1', port, deviceId: 0, linktestSec: 0 },
  });
  assert.equal(conn.result.isError, undefined);
  assert.match(conn.result.content[0].text, /SELECTED/);

  const start = await rpc.call(4, 'tools/call', { name: 'startup', arguments: {} });
  const report = JSON.parse(start.result.content[0].text);
  assert.equal(report.total, 10);
  assert.equal(report.passed, 10);
  assert.equal(report.rows[0].sent, 'S1F13');

  const sent = await rpc.call(5, 'tools/call', {
    name: 'send',
    arguments: { stream: 2, function: 41, body: { type: 'L', children: [{ type: 'A', value: 'START' }, { type: 'L', children: [] }] } },
  });
  assert.match(sent.result.content[0].text, /S2F42/);

  eq.sendS6F11(10002, 10002, [{ type: 'U4', value: [3] }]);
  await new Promise(r => setTimeout(r, 120));
  const ev = await rpc.call(6, 'tools/call', { name: 'events', arguments: {} });
  const events = JSON.parse(ev.result.content[0].text);
  assert.equal(events.length, 1);
  assert.equal(events[0].ceid, 10002);

  const st = await rpc.call(7, 'tools/call', { name: 'status', arguments: {} });
  assert.match(st.result.content[0].text, /"connected": ?true/);

  await rpc.call(8, 'tools/call', { name: 'disconnect', arguments: {} });
  rpc.kill();
  await eq.close();
});
