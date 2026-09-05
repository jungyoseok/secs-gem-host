import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, exitCode } from '../report.js';
import type { Report } from '../host.js';

const sample: Report = {
  rows: [
    { step: '1', sent: 'S1F13', expected: 'S1F14', got: 'S1F14', ack: '0', elapsedMs: 12, limitMs: 45000, result: 'PASS', note: '' },
    { step: '2', sent: 'S1F17', expected: 'S1F18', got: 'S1F18', ack: '1', elapsedMs: 8, limitMs: 45000, result: 'FAIL', note: 'ONLACK 1' },
  ],
  passed: 1,
  total: 2,
  flags: ['S9F9 received'],
};

test('renders the conformance table exactly', () => {
  assert.equal(renderReport(sample), [
    'Step Sent    Expect  Got     Ack  Time(ms)    Result  Note',
    '------------------------------------------------------------------------',
    '1    S1F13   S1F14   S1F14   0    12/45000    PASS',
    '2    S1F17   S1F18   S1F18   1    8/45000     FAIL    ONLACK 1',
    '------------------------------------------------------------------------',
    'E30 startup: 1/2 passed',
    'flag: S9F9 received',
  ].join('\n'));
});

test('exit code is 1 when any row failed, 0 otherwise', () => {
  assert.equal(exitCode(sample), 1);
  assert.equal(exitCode({ ...sample, rows: [sample.rows[0]], passed: 1, total: 1 }), 0);
});
