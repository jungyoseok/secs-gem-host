// SECS-II item codec + HSMS header codec.
//
// Ported from /opt/secs-gem-simulator/src/server.ts (encodeItem / decodeItem /
// encodeHeader / decodePacket / secsText). The item-tree JSON shape is deliberately
// identical to the simulator's paid /api/codec so bodies are interchangeable.
//
// Format byte = (format code << 2) | number of length bytes. For a list the length
// field counts CHILDREN, for everything else it counts BYTES.

export type SecsItem = { type: string; value?: any; children?: SecsItem[] };

export class CodecError extends Error {}

const FMT: Record<string, number> = {
  L: 0, B: 8, BOOLEAN: 9, A: 16, J: 17,
  I8: 24, I1: 25, I2: 26, I4: 28,
  F8: 32, F4: 36,
  U8: 40, U1: 41, U2: 42, U4: 44,
};
const FMT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(FMT).map(([k, v]) => [v, k]),
);
const ITEM_WIDTH: Record<string, number> = {
  I1: 1, U1: 1, I2: 2, U2: 2, I4: 4, U4: 4, F4: 4, I8: 8, U8: 8, F8: 8,
};
const MAX_DEPTH = 32;

export function item(type: string, value?: any, children?: SecsItem[]): SecsItem {
  return { type, value, children };
}

export function hex(b: Buffer): string {
  return b.toString('hex').replace(/../g, '$& ').trim().toUpperCase();
}

export function secsText(i: SecsItem, depth = 0): string {
  const sp = '  '.repeat(depth);
  if (i.type === 'L') {
    return `${sp}<L\n${(i.children || []).map(c => secsText(c, depth + 1)).join('\n')}\n${sp}>`;
  }
  return `${sp}<${i.type} ${JSON.stringify(i.value)}>`;
}

function lengthBytes(n: number): Buffer {
  if (n <= 0xff) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
  if (n <= 0xffffff) { const b = Buffer.alloc(3); b.writeUIntBE(n, 0, 3); return b; }
  throw new CodecError('item too large: length needs more than 3 bytes');
}

export function encodeItem(i: SecsItem, depth = 0): Buffer {
  if (depth > MAX_DEPTH) throw new CodecError(`item tree nested deeper than ${MAX_DEPTH}`);
  if (!i || typeof i.type !== 'string') throw new CodecError('each item needs a "type"');
  const code = FMT[i.type];
  if (code === undefined) {
    throw new CodecError(`unknown item type "${i.type}" (expected one of ${Object.keys(FMT).join(', ')})`);
  }
  if (i.type === 'L') {
    const kids = (i.children || []).map(c => encodeItem(c, depth + 1));
    const lb = lengthBytes(kids.length);
    return Buffer.concat([Buffer.from([(code << 2) | lb.length]), lb, ...kids]);
  }
  const vals = Array.isArray(i.value) ? i.value : [i.value];
  let data: Buffer;
  if (i.type === 'A' || i.type === 'J') {
    // latin1 keeps one byte per code unit, which is what SECS-II ASCII / JIS-8 is.
    data = Buffer.from(Array.isArray(i.value) ? i.value.join('') : String(i.value ?? ''), 'latin1');
  } else if (i.type === 'B') {
    data = Buffer.from(vals.map(v => Number(v) & 0xff));
  } else if (i.type === 'BOOLEAN') {
    data = Buffer.from(vals.map(v => (v ? 1 : 0)));
  } else {
    const w = ITEM_WIDTH[i.type];
    data = Buffer.alloc(w * vals.length);
    vals.forEach((v, n) => {
      const off = n * w;
      if (i.type === 'F4') data.writeFloatBE(Number(v), off);
      else if (i.type === 'F8') data.writeDoubleBE(Number(v), off);
      else if (i.type === 'U8') data.writeBigUInt64BE(BigInt(v ?? 0), off);
      else if (i.type === 'I8') data.writeBigInt64BE(BigInt(v ?? 0), off);
      else if (i.type[0] === 'U') data.writeUIntBE(Number(v) >>> 0, off, w);
      else data.writeIntBE(Number(v), off, w);
    });
  }
  const lb = lengthBytes(data.length);
  return Buffer.concat([Buffer.from([(code << 2) | lb.length]), lb, data]);
}

export function decodeItem(buf: Buffer, off = 0, depth = 0): { item: SecsItem; next: number } {
  if (depth > MAX_DEPTH) throw new CodecError(`item tree nested deeper than ${MAX_DEPTH}`);
  if (off >= buf.length) throw new CodecError('truncated body: expected an item format byte');
  const fb = buf[off];
  const code = fb >> 2;
  const nlen = fb & 3;
  const type = FMT_NAME[code];
  if (!type) throw new CodecError(`unknown SECS-II format code ${code} at byte ${off}`);
  if (nlen === 0) throw new CodecError(`item at byte ${off} declares zero length bytes`);
  if (off + 1 + nlen > buf.length) throw new CodecError(`truncated body: length bytes run past the end at ${off}`);
  const len = buf.readUIntBE(off + 1, nlen);
  let p = off + 1 + nlen;
  if (type === 'L') {
    const children: SecsItem[] = [];
    for (let n = 0; n < len; n++) {
      const r = decodeItem(buf, p, depth + 1);
      children.push(r.item);
      p = r.next;
    }
    return { item: { type, children }, next: p };
  }
  if (p + len > buf.length) {
    throw new CodecError(`truncated body: item at byte ${off} claims ${len} bytes, only ${buf.length - p} left`);
  }
  const data = buf.subarray(p, p + len);
  p += len;
  let value: any;
  if (type === 'A' || type === 'J') value = data.toString('latin1');
  else if (type === 'B') value = [...data];
  else if (type === 'BOOLEAN') value = [...data].map(b => b !== 0);
  else {
    const w = ITEM_WIDTH[type];
    if (len % w) throw new CodecError(`${type} item at byte ${off} has ${len} bytes, not a multiple of ${w}`);
    value = [];
    for (let n = 0; n < len; n += w) {
      if (type === 'F4') value.push(data.readFloatBE(n));
      else if (type === 'F8') value.push(data.readDoubleBE(n));
      // U8/I8 come back as Number, so magnitudes past 2^53 lose precision.
      // JSON has no int64 either; switch to strings here and in encodeItem if it matters.
      else if (type === 'U8') value.push(Number(data.readBigUInt64BE(n)));
      else if (type === 'I8') value.push(Number(data.readBigInt64BE(n)));
      else if (type[0] === 'U') value.push(data.readUIntBE(n, w));
      else value.push(data.readIntBE(n, w));
    }
  }
  return { item: { type, value }, next: p };
}

export function encodeHeader(
  sessionId: number, stream: number, func: number, ptype: number, stype: number,
  sys: number, body: string | Buffer = '', wbit = false,
): Buffer {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(sessionId, 0);
  h[2] = (stream & 0x7f) | (wbit ? 0x80 : 0);
  h[3] = func;
  h[4] = ptype;
  h[5] = stype;
  h.writeUInt32BE(sys >>> 0, 6);
  const bb = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(10 + bb.length);
  return Buffer.concat([len, h, bb]);
}

export type DecodedPacket = {
  len: number; sessionId: number; stream: number; wbit: boolean; function: number;
  ptype: number; stype: number; systemBytes: number; body: Buffer; rawHex: string;
};

export function decodePacket(buf: Buffer): DecodedPacket | null {
  if (buf.length < 14) return null;
  const len = buf.readUInt32BE(0);
  const h = buf.subarray(4, 14);
  return {
    len,
    sessionId: h.readUInt16BE(0),
    stream: h[2] & 0x7f,
    wbit: !!(h[2] & 0x80),
    function: h[3],
    ptype: h[4],
    stype: h[5],
    systemBytes: h.readUInt32BE(6),
    body: buf.subarray(14),
    rawHex: hex(buf),
  };
}
