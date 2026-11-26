import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('PR #1 project scaffold & build configuration', () => {
  it('declares dot-stash as the sole runtime dependency and Node >= 22 engine', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'mplay3r');
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['dot-stash']);
    assert.match(pkg.dependencies['dot-stash'], /dot-stash-0\.2\.0\.tgz$/);
    assert.equal(pkg.engines?.node, '>=22');
  });

  it('ships all required build scripts, theme entrypoints, and Stencil targets', () => {
    const requiredFiles = [
      'stencil.config.ts',
      'tsconfig.json',
      'tsconfig.build.json',
      'eslint.config.mjs',
      'stylelint.config.mjs',
      'scripts/build-css.mjs',
      'scripts/dev.mjs',
      'scripts/ts-loader.mjs',
      'scss/themes/minimal/_tokens.scss',
      'scss/themes/minimal/index.scss',
      'scss/themes/minimal/app.scss',
      'src/global/app.ts',
      'src/index.ts',
      'src/index.html',
      'src/components/mplay3r-app/mplay3r-app.tsx',
      '.github/workflows/ci.yml',
    ];

    for (const rel of requiredFiles) {
      assert.ok(fs.existsSync(path.join(root, rel)), `Expected ${rel} to exist`);
    }
  });
});
