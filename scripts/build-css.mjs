// Compiles mPlay3r theme stylesheets with Dart Sass using the dot-stash SCSS engine:
//   scss/themes/minimal/index.scss -> dist/css/minimal.css (embeddable player stylesheet)
//   scss/themes/minimal/app.scss   -> dist/css/app.css     (standalone web/desktop shell)
//
// Usage: node scripts/build-css.mjs [--watch] [--strict] [--source-map]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as sass from 'sass';

const options = {
  watch: { type: 'boolean' },
  strict: { type: 'boolean' },
  'source-map': { type: 'boolean' },
};

let flags;
try {
  ({ values: flags } = parseArgs({ options }));
} catch (error) {
  console.error(`${error.message}\nUsage: node scripts/build-css.mjs [--watch] [--strict] [--source-map]`);
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const scssDir = path.join(root, 'scss');
const cssDir = path.join(root, 'dist', 'css');
const sourceMap = Boolean(flags['source-map']);
const relative = file => path.relative(root, file);

const jobs = [
  {
    source: path.join(scssDir, 'themes', 'minimal', 'index.scss'),
    destination: path.join(cssDir, 'minimal.css'),
  },
  {
    source: path.join(scssDir, 'themes', 'minimal', 'app.scss'),
    destination: path.join(cssDir, 'app.css'),
  },
];

const copyIconsLicense = () => {
  const candidates = [
    path.join(root, 'node_modules', 'dot-stash', 'dist', 'css', 'LICENSE-icons.txt'),
    path.join(root, 'node_modules', 'dot-stash', 'scss', 'engine', 'icons', 'LICENSE'),
  ];
  const src = candidates.find(candidate => fs.existsSync(candidate));
  if (src) {
    const dest = path.join(cssDir, 'LICENSE-icons.txt');
    fs.copyFileSync(src, dest);
    console.log(`${relative(src)} -> ${relative(dest)}`);
  }
};

const compile = ({ source, destination }) => {
  let warnings = 0;
  const logger = {
    warn(message, { deprecation, span, stack }) {
      warnings += 1;
      const where =
        span?.url?.protocol === 'file:'
          ? `\n    ${relative(fileURLToPath(span.url))} ${span.start.line + 1}:${span.start.column + 1}`
          : stack
            ? `\n${stack.trimEnd()}`
            : '';
      console.warn(`${deprecation ? 'Deprecation warning' : 'Warning'}: ${message}${where}`);
    },
  };

  const result = sass.compile(source, {
    style: 'compressed',
    sourceMap,
    sourceMapIncludeSources: sourceMap,
    loadPaths: [path.join(root, 'node_modules')],
    importers: [new sass.NodePackageImporter(root)],
    logger,
  });

  if (flags.strict && warnings > 0) {
    throw new Error(`${relative(source)}: ${warnings} Sass warning(s), failing due to --strict.`);
  }

  let { css } = result;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (result.sourceMap) {
    const toRel = url => (url.startsWith('file:') ? path.relative(path.dirname(destination), fileURLToPath(url)).split(path.sep).join('/') : url);
    const map = { ...result.sourceMap, file: path.basename(destination), sources: result.sourceMap.sources.map(toRel) };
    fs.writeFileSync(`${destination}.map`, JSON.stringify(map));
    css += `\n/*# sourceMappingURL=${path.basename(destination)}.map */`;
  }
  fs.writeFileSync(destination, css);
  const kb = (Buffer.byteLength(css, 'utf8') / 1024).toFixed(1);
  console.log(`${relative(source)} -> ${relative(destination)} (${kb} KB)`);
};

const runAll = () =>
  jobs
    .map(job => {
      try {
        compile(job);
        return true;
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    })
    .every(Boolean);

fs.rmSync(cssDir, { recursive: true, force: true });
fs.mkdirSync(cssDir, { recursive: true });
copyIconsLicense();
const ok = runAll();

if (flags.watch) {
  let timer;
  fs.watch(scssDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('.scss')) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n[${new Date().toLocaleTimeString()}] Recompiling stylesheets...`);
      runAll();
    }, 100);
  });
  console.log(`Watching ${relative(scssDir)}/ for changes...`);
  if (process.send) {
    process.send('ready');
    process.on('disconnect', () => process.exit());
  }
} else if (!ok) {
  process.exitCode = 1;
}
