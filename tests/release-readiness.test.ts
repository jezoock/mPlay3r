import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('PR #16 — Release v0.1.0 Readiness & GitHub Pages Workflow', () => {
  it('passes scripts/check-release.mjs verifying version parity across TS, Rust, Tauri, and CHANGELOG', () => {
    const output = execFileSync(process.execPath, [path.join(root, 'scripts/check-release.mjs')], {
      encoding: 'utf8',
    });
    assert.ok(output.includes('Release readiness check passed'));

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      version: string;
    };
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

    assert.ok(cargo.includes(`version = "${pkg.version}"`));
    assert.equal(tauri.version, pkg.version);
    assert.ok(changelog.includes(`## [${pkg.version}]`));
  });

  it('ships valid GitHub Pages and Release workflows packaging Web/PWA, Embed, and Desktop builds', () => {
    const pagesYml = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
    assert.ok(pagesYml.includes('actions/upload-pages-artifact@v3'));
    assert.ok(pagesYml.includes('actions/deploy-pages@v4'));
    assert.ok(pagesYml.includes('www/.nojekyll'));

    const releaseYml = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.ok(releaseYml.includes('release-web-embed:'));
    assert.ok(releaseYml.includes('build-desktop:'));
    assert.ok(releaseYml.includes('SHA256SUMS-web-'));
    assert.ok(releaseYml.includes('mPlay3r-windows-portable-'));
    assert.ok(releaseYml.includes('--notes-file CHANGELOG.md'));
  });
});
