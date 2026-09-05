import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = () => fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

test('README documents the CLI, the MCP registration and the scenario schema', () => {
  const r = readme();
  for (const needle of [
    'npx secs-gem-host connect',
    '--report',
    '--scenario',
    '--passive',
    'claude mcp add',
    'secs-gem-host mcp',
    '"drop-ack"',
    '"sleep-t3"',
    '"expect"',
    'Known findings',
  ]) {
    assert.ok(r.includes(needle), `README is missing ${JSON.stringify(needle)}`);
  }
});

test('README names no customer', () => {
  const r = readme();
  for (const banned of ['LG', 'Foxconn', 'Simmtech', 'MoldPress', 'SEMV', 'SEMB']) {
    assert.ok(!r.includes(banned), `README leaks "${banned}"`);
  }
});
