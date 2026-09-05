import test from 'node:test';
import assert from 'node:assert/strict';
import { item, encodeItem, decodeItem, encodeHeader, decodePacket, secsText, CodecError } from '../codec.js';

const roundTrip = (i: any) => decodeItem(encodeItem(i)).item;

test('S1F13 body round-trips', () => {
  const body = item('L', undefined, [item('A', 'GEMHOST'), item('A', '0.1.0')]);
  assert.deepEqual(roundTrip(body), {
    type: 'L',
    children: [{ type: 'A', value: 'GEMHOST' }, { type: 'A', value: '0.1.0' }],
  });
});

test('nested L / A / U4 / BOOLEAN round-trips', () => {
  const body = item('L', undefined, [
    item('U4', [1]),
    item('L', undefined, [item('A', 'SV_101'), item('U4', [101, 102])]),
    item('BOOLEAN', [true, false, true]),
  ]);
  assert.deepEqual(roundTrip(body), {
    type: 'L',
    children: [
      { type: 'U4', value: [1] },
      { type: 'L', children: [{ type: 'A', value: 'SV_101' }, { type: 'U4', value: [101, 102] }] },
      { type: 'BOOLEAN', value: [true, false, true] },
    ],
  });
});

test('empty list round-trips', () => {
  assert.deepEqual(roundTrip(item('L', undefined, [])), { type: 'L', children: [] });
});

test('every numeric type round-trips', () => {
  const cases: [string, number[]][] = [
    ['I1', [-128, 0, 127]],
    ['I2', [-32768, 32767]],
    ['I4', [-2147483648, 2147483647]],
    ['I8', [-1, 0, 1]],
    ['U1', [0, 255]],
    ['U2', [0, 65535]],
    ['U4', [0, 4294967295]],
    ['U8', [0, 1, 9007199254740991]],
    ['F8', [3.141592653589793, -0.5]],
  ];
  for (const [type, value] of cases) {
    assert.deepEqual(roundTrip(item(type, value)), { type, value }, type);
  }
  const f4 = roundTrip(item('F4', [1.5, -2.25]));
  assert.deepEqual(f4, { type: 'F4', value: [1.5, -2.25] });
});

test('B round-trips as a byte array', () => {
  assert.deepEqual(roundTrip(item('B', [0, 0x80, 0xff])), { type: 'B', value: [0, 128, 255] });
});

test('secsText renders SML', () => {
  const body = item('L', undefined, [item('A', 'VX-9000'), item('U4', [1, 2])]);
  assert.equal(secsText(body), '<L\n  <A "VX-9000">\n  <U4 [1,2]>\n>');
});

test('header encodes and decodes with W-bit and system bytes', () => {
  const body = encodeItem(item('L', undefined, [item('A', 'X')]));
  const frame = encodeHeader(11, 1, 13, 0, 0, 0x12345678, body, true);
  const d = decodePacket(frame)!;
  assert.equal(d.len, 10 + body.length);
  assert.equal(d.sessionId, 11);
  assert.equal(d.stream, 1);
  assert.equal(d.function, 13);
  assert.equal(d.wbit, true);
  assert.equal(d.stype, 0);
  assert.equal(d.systemBytes, 0x12345678);
  assert.deepEqual(decodeItem(d.body).item, { type: 'L', children: [{ type: 'A', value: 'X' }] });
});

test('control frames have no body', () => {
  const frame = encodeHeader(11, 0, 0, 0, 1, 7);
  const d = decodePacket(frame)!;
  assert.equal(d.stype, 1);
  assert.equal(d.body.length, 0);
});

test('truncated body raises CodecError', () => {
  assert.throws(() => decodeItem(Buffer.from([(16 << 2) | 1, 10, 0x41])), CodecError);
});

test('unknown type raises CodecError', () => {
  assert.throws(() => encodeItem({ type: 'Q', value: 1 }), CodecError);
});

test('a zero-length U4 item encodes as one format byte plus a zero length', () => {
  assert.deepEqual([...encodeItem(item('U4', []))], [0xb1, 0x00]);
});
