import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PALETTES } from '../src/core/constants';

const root = fileURLToPath(new URL('..', import.meta.url));
const componentsDir = path.join(root, 'src', 'components');
const themeDir = path.join(root, 'scss', 'themes', 'minimal');

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('PR #4 UI components (dot-stash + ds-trigger) & minimal theme contracts', () => {
  it('maps every ds-trigger action in child components to a public @Method() on mplay3r-app', () => {
    const appSource = readText(path.join(componentsDir, 'mplay3r-app', 'mplay3r-app.tsx'));
    const methodMatches = Array.from(appSource.matchAll(/@Method\(\)\s+async\s+([a-zA-Z0-9_]+)\s*\(/g));
    const publicMethods = new Set(methodMatches.map(m => m[1]));

    assert.ok(publicMethods.size >= 25, `Expected at least 25 public @Method() actions, found ${publicMethods.size}`);

    const discoveredActions = new Set<string>();
    for (const file of listTsxFiles(componentsDir)) {
      const source = readText(file);
      // Matches both `action="play"` and `action={`playTrack:${...}`}`
      for (const match of source.matchAll(/action=(?:"([a-zA-Z0-9_]+)(?::[^"]*)?"|\{`([a-zA-Z0-9_]+):)/g)) {
        const actionName = match[1] || match[2];
        if (actionName) {
          discoveredActions.add(actionName);
        }
      }
    }

    assert.ok(discoveredActions.size >= 15, `Expected at least 15 distinct ds-trigger actions, found ${discoveredActions.size}`);
    for (const action of discoveredActions) {
      assert.ok(publicMethods.has(action), `ds-trigger action "${action}" has no matching @Method() on MPlay3rApp`);
    }
  });

  it('maps every ds-icon type rendered in TSX inside minimal/_icons.scss', () => {
    const iconsScss = readText(path.join(themeDir, '_icons.scss'));
    const mappedIcons = new Set<string>();
    for (const match of iconsScss.matchAll(/^\s*([a-z0-9-]+)\s*:\s*[a-z0-9-]+\s*,/gm)) {
      mappedIcons.add(match[1]);
    }

    const usedIcons = new Set<string>();
    for (const file of listTsxFiles(componentsDir)) {
      const source = readText(file);
      for (const match of source.matchAll(/<ds-icon[^>]*\stype="([a-z0-9-]+)"/g)) {
        usedIcons.add(match[1]);
      }
      for (const match of source.matchAll(/<ds-icon[^>]*\stype=\{[^}]*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) {
        usedIcons.add(match[1]);
        usedIcons.add(match[2]);
      }
    }

    // Dynamic volume icons returned by MpTransport.getVolumeIcon()
    for (const dynamicIcon of ['volume-high', 'volume-low', 'volume-mute']) {
      usedIcons.add(dynamicIcon);
    }

    assert.ok(usedIcons.size >= 18, `Expected at least 18 icon types, found ${usedIcons.size}`);
    for (const icon of usedIcons) {
      assert.ok(mappedIcons.has(icon), `<ds-icon type="${icon}"> is not mapped in scss/themes/minimal/_icons.scss`);
    }
  });

  it('defines all 5 minimalist palettes with scoped dot-stash token redeclaration', () => {
    const palettesScss = readText(path.join(themeDir, '_palettes.scss'));
    for (const palette of PALETTES) {
      assert.ok(
        palettesScss.includes(`[data-mp-palette='${palette.id}']`),
        `Palette "${palette.id}" missing from scss/themes/minimal/_palettes.scss`,
      );
    }
    const tokenMixins = palettesScss.match(/@include ds-tokens\(colorset,\s*focus\);/g) ?? [];
    assert.equal(tokenMixins.length, PALETTES.length, 'Every palette must re-emit scoped colorset and focus tokens');
  });

  it('compiles minimal.css with all 5 palettes, icons, no global body reset, and lightweight size budget', () => {
    const compiledPath = path.join(root, 'dist', 'css', 'minimal.css');
    if (!fs.existsSync(compiledPath)) {
      // Skipped when running tests without prior Sass build (always executed in CI after `npm run build`).
      return;
    }

    const css = readText(compiledPath);
    for (const palette of PALETTES) {
      assert.ok(css.includes(`[data-mp-palette=${palette.id}]`) || css.includes(`[data-mp-palette="${palette.id}"]`) || css.includes(`[data-mp-palette='${palette.id}']`), `Compiled minimal.css missing palette "${palette.id}"`);
    }
    assert.ok(css.includes('--ds-color-primary-base:'), 'Compiled CSS must declare dot-stash primary token');
    assert.ok(css.includes('--ds-icons-play:'), 'Compiled CSS must emit play icon token');
    assert.ok(css.includes('--ds-icons-shuffle:'), 'Compiled CSS must emit custom shuffle icon token');
    assert.ok(!/(?:^|})body\{/.test(css), 'Embeddable minimal.css must never emit global body rules');
    assert.ok(!/(?:^|})h1\{/.test(css), 'Embeddable minimal.css must never emit global h1 rules');

    const sizeKb = Buffer.byteLength(css, 'utf8') / 1024;
    assert.ok(sizeKb < 50, `Expected minimal.css under 50 KB uncompressed, got ${sizeKb.toFixed(1)} KB`);
  });
});
