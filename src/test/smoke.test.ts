import test from 'node:test';
import assert from 'node:assert/strict';

test('toolchain compiles and node --test runs', () => {
  assert.equal(1 + 1, 2);
});
