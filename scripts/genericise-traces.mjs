// One-shot: copy trace captures from source captures into fixtures/traces/ with the
// customer data removed. Keeps the sample values (plain numbers), drops the .NET tick
// timestamps in column 0 in favour of millisecond offsets, and renumbers the VIDs to a
// dense 10001..1000N.
//
//   node scripts/genericise-traces.mjs <src-dir> <file1.csv> <file2.csv> <file3.csv>
import fs from 'node:fs';
import path from 'node:path';

const [srcDir, ...names] = process.argv.slice(2);
if (!srcDir || names.length === 0) {
  console.error('usage: node scripts/genericise-traces.mjs <src-dir> <file.csv>...');
  process.exit(2);
}
const outDir = new URL('../fixtures/traces/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

names.forEach((name, idx) => {
  const lines = fs.readFileSync(path.join(srcDir, name), 'utf8')
    .split(/\r?\n/).filter(l => l.trim().length > 0)
    .map(l => l.replace(/,\s*$/, '').split(','));
  const [meta, types, , ...rows] = lines;
  const vids = types.map((_, i) => String(10001 + i));
  const dsper = Number(meta[1]) || 1000;
  const out = [
    meta.join(','),
    types.join(','),
    vids.join(','),
    ...rows.map((r, n) => [String(n * dsper), ...r.slice(1, types.length + 1)].join(',')),
  ].join('\n');
  const dest = new URL(`trace-${idx + 1}.csv`, outDir);
  fs.writeFileSync(dest, `${out}\n`);
  console.log(`wrote ${dest.pathname} (${rows.length} samples, ${types.length} columns)`);
});
