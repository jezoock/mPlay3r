// Enforces mPlay3r's lightweight weight budgets across compiled CSS, JS, and PWA outputs.
// Runs in CI after `npm run build` with zero external dependencies (Node 22 built-in zlib).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));

const USED_DS_COMPONENTS = ['ds-badge', 'ds-icon', 'ds-range', 'ds-select', 'ds-sortable', 'ds-toaster', 'ds-toggle', 'ds-tooltip', 'ds-trigger'];
const MPLAY3R_COMPONENTS = ['mplay3r-app', 'mp-header', 'mp-transport', 'mp-equalizer', 'mp-playlist'];

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function measureBuffer(label, buf) {
  return {
    label,
    raw: buf.byteLength,
    gzip: gzipSync(buf, { level: 9 }).byteLength,
    brotli: brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    }).byteLength,
  };
}

function measureFile(relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing build output: ${relPath}`);
  }
  return measureBuffer(relPath, fs.readFileSync(full));
}

function measureFiles(label, relDir, predicate) {
  const fullDir = path.join(root, relDir);
  if (!fs.existsSync(fullDir)) {
    throw new Error(`Missing build directory: ${relDir}`);
  }
  const files = fs
    .readdirSync(fullDir)
    .filter(name => name.endsWith('.js') && !name.endsWith('.cjs.js') && predicate(name))
    .sort();
  if (files.length === 0) {
    throw new Error(`No matching JS bundles found in ${relDir} for ${label}`);
  }
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const name of files) {
    const metrics = measureBuffer(name, fs.readFileSync(path.join(fullDir, name)));
    raw += metrics.raw;
    gzip += metrics.gzip;
    brotli += metrics.brotli;
  }
  return {
    label: `${label} (${files.length} files)`,
    raw,
    gzip,
    brotli,
  };
}

function isPlayerRuntimeChunk(filename) {
  if (filename === 'mplay3r.esm.js' || filename.startsWith('p-')) {
    return true;
  }
  return [...MPLAY3R_COMPONENTS, ...USED_DS_COMPONENTS].some(tag => filename.startsWith(tag));
}

const checks = [
  { metric: measureFile('dist/css/minimal.css'), maxRawKb: 56, maxGzipKb: 12 },
  { metric: measureFile('dist/css/app.css'), maxRawKb: 4, maxGzipKb: 2 },
  { metric: measureFile('www/sw.js'), maxRawKb: 4, maxGzipKb: 2 },
  { metric: measureFile('www/icons/icon.svg'), maxRawKb: 2, maxGzipKb: 1 },
  { metric: measureFile('dist/components/mplay3r-app.js'), maxGzipKb: 10 },
  {
    metric: measureFiles('dist/components (mp-*)', 'dist/components', name => MPLAY3R_COMPONENTS.some(tag => name === `${tag}.js`)),
    maxGzipKb: 20,
  },
  {
    metric: measureFiles('www/build runtime payload', 'www/build', isPlayerRuntimeChunk),
    maxGzipKb: 50,
  },
  {
    metric: measureFiles('www/build full lazy dir', 'www/build', () => true),
    maxGzipKb: 120,
  },
  {
    metric: measureFiles('dist/mplay3r full lazy dir', 'dist/mplay3r', () => true),
    maxGzipKb: 120,
  },
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
    `  [${status}] ${metric.label.padEnd(40)} raw=${formatKb(metric.raw).padStart(9)}  gzip=${formatKb(metric.gzip).padStart(9)}  br=${formatKb(metric.brotli).padStart(9)}`,
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
