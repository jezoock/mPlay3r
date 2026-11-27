// Enforces mPlay3r's lightweight weight budgets across compiled CSS, JS, and PWA outputs.
// Runs in CI after `npm run build` with zero external dependencies (Node 22 built-in zlib).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function measureFile(relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing build output: ${relPath}`);
  }
  const buf = fs.readFileSync(full);
  return {
    label: relPath,
    raw: buf.byteLength,
    gzip: gzipSync(buf, { level: 9 }).byteLength,
    brotli: brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    }).byteLength,
  };
}

function measureDirJs(relDir) {
  const fullDir = path.join(root, relDir);
  if (!fs.existsSync(fullDir)) {
    throw new Error(`Missing build directory: ${relDir}`);
  }
  const files = fs
    .readdirSync(fullDir)
    .filter(name => name.endsWith('.js') && !name.endsWith('.cjs.js'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No JS bundles found in ${relDir}`);
  }
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const name of files) {
    const buf = fs.readFileSync(path.join(fullDir, name));
    raw += buf.byteLength;
    gzip += gzipSync(buf, { level: 9 }).byteLength;
    brotli += brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    }).byteLength;
  }
  return {
    label: `${relDir}/*.js (${files.length} files)`,
    raw,
    gzip,
    brotli,
  };
}

const checks = [
  { metric: measureFile('dist/css/minimal.css'), maxRawKb: 56, maxGzipKb: 12 },
  { metric: measureFile('dist/css/app.css'), maxRawKb: 4, maxGzipKb: 2 },
  { metric: measureFile('www/sw.js'), maxRawKb: 4, maxGzipKb: 2 },
  { metric: measureFile('www/icons/icon.svg'), maxRawKb: 2, maxGzipKb: 1 },
  { metric: measureDirJs('www/build'), maxGzipKb: 65 },
  { metric: measureDirJs('dist/mplay3r'), maxGzipKb: 65 },
  { metric: measureFile('dist/components/mplay3r-app.js'), maxGzipKb: 45 },
];

const failures = [];
console.log('mPlay3r bundle weight report:');
for (const { metric, maxRawKb, maxGzipKb } of checks) {
  const rawKb = metric.raw / 1024;
  const gzipKb = metric.gzip / 1024;
  const status =
    (maxRawKb !== undefined && rawKb > maxRawKb) || (maxGzipKb !== undefined && gzipKb > maxGzipKb)
      ? 'FAIL'
      : 'OK';

  console.log(
    `  [${status}] ${metric.label.padEnd(36)} raw=${formatKb(metric.raw).padStart(9)}  gzip=${formatKb(metric.gzip).padStart(9)}  br=${formatKb(metric.brotli).padStart(9)}`,
  );

  if (maxRawKb !== undefined && rawKb > maxRawKb) {
    failures.push(`${metric.label}: raw ${formatKb(metric.raw)} exceeds budget ${maxRawKb} KB`);
  }
  if (maxGzipKb !== undefined && gzipKb > maxGzipKb) {
    failures.push(`${metric.label}: gzip ${formatKb(metric.gzip)} exceeds budget ${maxGzipKb} KB`);
  }
}

if (failures.length > 0) {
  console.error('\nBundle weight budget exceeded:');
  for (const line of failures) {
    console.error(`  - ${line}`);
  }
  process.exit(1);
}
