import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { resolveTracksInput } from '../src/core/playlist-io';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(root, 'src');

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('PR #5 Web / PWA & Embeddable Web Component', () => {
  describe('resolveTracksInput (<mplay3r-app tracks="...">)', () => {
    it('accepts TrackInput arrays and drops entries with missing src', async () => {
      const result = await resolveTracksInput([
        { src: '/audio/one.mp3', title: 'Track One' },
        { src: '   ', title: 'Invalid' },
        { src: 'https://cdn.example/two.flac', artist: 'Artist' },
      ]);
      assert.equal(result.error, undefined);
      assert.equal(result.tracks.length, 2);
      assert.equal(result.tracks[0].src, '/audio/one.mp3');
      assert.equal(result.tracks[1].src, 'https://cdn.example/two.flac');
    });

    it('parses JSON array attributes and reports invalid JSON cleanly', async () => {
      const ok = await resolveTracksInput('[{"src":"/a.mp3","title":"A"},{"src":"/b.ogg","artist":"B"}]');
      assert.equal(ok.error, undefined);
      assert.equal(ok.tracks.length, 2);
      assert.equal(ok.tracks[0].title, 'A');

      const bad = await resolveTracksInput('[{"src": broken');
      assert.equal(bad.error, 'invalid-json');
      assert.deepEqual(bad.tracks, []);
    });

    it('loads remote M3U8 and PLS playlist URLs via fetcher and resolves relative track URLs', async () => {
      const m3uBody = '#EXTM3U\n#EXTINF:180,Daft Punk - Da Funk\ntracks/da-funk.mp3\n';
      const mockFetch = (async (url: string | URL) =>
        ({
          ok: true,
          url: String(url),
          text: async () => m3uBody,
        }) as unknown as Response) as typeof fetch;

      const m3uResult = await resolveTracksInput('https://music.example/lists/demo.m3u8', mockFetch);
      assert.equal(m3uResult.error, undefined);
      assert.equal(m3uResult.tracks.length, 1);
      assert.equal(m3uResult.tracks[0].src, 'https://music.example/lists/tracks/da-funk.mp3');
      assert.equal(m3uResult.tracks[0].artist, 'Daft Punk');
      assert.equal(m3uResult.tracks[0].title, 'Da Funk');

      const plsBody = '[playlist]\nFile1=https://stream.example/a.ogg\nTitle1=Boards - Roygbiv\nLength1=151\n';
      const plsFetch = (async (url: string | URL) =>
        ({
          ok: true,
          url: String(url),
          text: async () => plsBody,
        }) as unknown as Response) as typeof fetch;

      const plsResult = await resolveTracksInput('/playlists/winamp.pls', plsFetch);
      assert.equal(plsResult.error, undefined);
      assert.equal(plsResult.tracks.length, 1);
      assert.equal(plsResult.tracks[0].src, 'https://stream.example/a.ogg');
      assert.equal(plsResult.tracks[0].duration, 151);
    });

    it('supports a direct audio file URL and handles playlist fetch failures gracefully', async () => {
      const single = await resolveTracksInput('/audio/standalone-track.flac');
      assert.equal(single.error, undefined);
      assert.deepEqual(single.tracks, [{ src: '/audio/standalone-track.flac' }]);

      const notFoundFetch = (async () => ({ ok: false, status: 404 }) as unknown as Response) as typeof fetch;
      const failed = await resolveTracksInput('https://music.example/missing.m3u8', notFoundFetch);
      assert.equal(failed.error, 'fetch-failed');
      assert.deepEqual(failed.tracks, []);

      const throwingFetch = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const offline = await resolveTracksInput('https://music.example/list.pls', throwingFetch);
      assert.equal(offline.error, 'fetch-failed');
      assert.deepEqual(offline.tracks, []);
    });
  });

  describe('multi-instance embedding & external ds-trigger demo', () => {
    it('isolates embed-demo.html with minimal.css only and wires every external ds-trigger to a valid host & @Method()', () => {
      const html = readText(path.join(srcDir, 'embed-demo.html'));
      const appSource = readText(path.join(srcDir, 'components', 'mplay3r-app', 'mplay3r-app.tsx'));
      const publicMethods = new Set(Array.from(appSource.matchAll(/@Method\(\)\s+async\s+([a-zA-Z0-9_]+)\s*\(/g), m => m[1]));

      assert.ok(html.includes('/css/minimal.css'), 'embed-demo.html must load scoped minimal.css');
      assert.ok(!html.includes('/css/app.css'), 'embed-demo.html must not load standalone app.css');

      const playerIds = Array.from(html.matchAll(/<mplay3r-app[^>]*\sid="([^"]+)"/g), m => m[1]);
      assert.ok(playerIds.length >= 3, `Expected at least 3 embedded <mplay3r-app> instances, found ${playerIds.length}`);
      assert.equal(new Set(playerIds).size, playerIds.length, 'Every embedded <mplay3r-app> must have a unique id');
      assert.ok(html.includes('palette="sand"'), 'Demo should showcase scoped sand palette');
      assert.ok(html.includes('palette="amber"'), 'Demo should showcase scoped amber palette');
      assert.ok(html.includes('compact="true"'), 'Demo should showcase compact mode');
      assert.ok(html.includes('headless="true"'), 'Demo should showcase headless custom UI mode');

      const triggers = Array.from(
        html.matchAll(/<ds-trigger[^>]*\starget="#([^"]+)"[^>]*\saction=(?:"([a-zA-Z0-9_]+)(?::[^"]*)?"|'([a-zA-Z0-9_]+)(?::[^']*)?')/g),
      );
      assert.ok(triggers.length >= 8, `Expected at least 8 external ds-trigger bindings, found ${triggers.length}`);

      const idSet = new Set(playerIds);
      for (const match of triggers) {
        const targetId = match[1];
        const actionName = match[2] || match[3];
        assert.ok(idSet.has(targetId), `ds-trigger targets unknown player "#${targetId}"`);
        assert.ok(publicMethods.has(actionName), `ds-trigger action "${actionName}" is not a @Method() on MPlay3rApp`);
      }
    });

    it('allocates unique automatic host IDs on MPlay3rApp when embedded without explicit id attributes', () => {
      const appSource = readText(path.join(srcDir, 'components', 'mplay3r-app', 'mplay3r-app.tsx'));
      assert.match(appSource, /let instanceCounter = 0;/, 'Expected monotonic instanceCounter for multi-instance isolation');
      assert.match(appSource, /if \(!this\.host\.id\)[\s\S]*?instanceCounter \+= 1;[\s\S]*?this\.host\.id = `mplay3r-\$\{instanceCounter\}`;/);
    });
  });

  describe('standalone Web / PWA packaging', () => {
    it('ships a valid manifest.webmanifest pointing to a lightweight SVG icon', () => {
      const manifest = JSON.parse(readText(path.join(srcDir, 'manifest.webmanifest'))) as {
        name?: string;
        short_name?: string;
        start_url?: string;
        display?: string;
        icons?: Array<{ src: string; type: string }>;
      };

      assert.equal(manifest.name, 'mPlay3r');
      assert.equal(manifest.short_name, 'mPlay3r');
      assert.equal(manifest.start_url, './');
      assert.equal(manifest.display, 'standalone');
      assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1, 'Manifest must declare at least one icon');

      const iconRel = manifest.icons[0].src.replace(/^\.?\//, '');
      const iconPath = path.join(srcDir, iconRel);
      assert.ok(fs.existsSync(iconPath), `Manifest icon not found at src/${iconRel}`);
      const svg = readText(iconPath);
      assert.ok(svg.includes('<svg') && svg.includes('</svg>'), 'PWA icon must be valid SVG');
      assert.ok(Buffer.byteLength(svg, 'utf8') < 2048, 'PWA SVG icon should stay under 2 KB');
    });

    it('wires favicon, manifest, and Tauri-safe service worker registration in src/index.html and valid src/sw.js', () => {
      const indexHtml = readText(path.join(srcDir, 'index.html'));
      assert.ok(indexHtml.includes('href="./icons/icon.svg"'), 'index.html must link the SVG favicon via relative path');
      assert.ok(indexHtml.includes('href="./manifest.webmanifest"'), 'index.html must link manifest.webmanifest via relative path');
      assert.ok(indexHtml.includes("register('./sw.js')"), 'index.html must register ./sw.js via relative path');
      assert.ok(indexHtml.includes('__TAURI_INTERNALS__'), 'Service worker registration must be skipped inside Tauri desktop');

      const swSource = readText(path.join(srcDir, 'sw.js'));
      // Verify syntactic validity without executing Service Worker globals.
      assert.doesNotThrow(() => new vm.Script(swSource, { filename: 'src/sw.js' }), 'src/sw.js must be syntactically valid JavaScript');
      assert.ok(swSource.includes("request.headers.has('range')"), 'Service worker must bypass HTTP Range audio requests');
      assert.ok(swSource.includes('url.origin !== self.location.origin'), 'Service worker must never intercept cross-origin streams');
    });

    it('emits all Web/PWA, custom-elements, and loader targets after build', () => {
      const wwwDir = path.join(root, 'www');
      if (!fs.existsSync(wwwDir)) {
        // Skipped locally when Stencil build has not been run; always verified in CI.
        return;
      }

      const requiredOutputs = [
        'www/index.html',
        'www/embed-demo.html',
        'www/manifest.webmanifest',
        'www/icons/icon.svg',
        'www/sw.js',
        'www/css/minimal.css',
        'www/css/app.css',
        'www/build/mplay3r.esm.js',
        'dist/mplay3r/mplay3r.esm.js',
        'dist/components/index.js',
        'dist/components/mplay3r-app.js',
        'loader/index.js',
      ];
      for (const rel of requiredOutputs) {
        const full = path.join(root, rel);
        assert.ok(fs.existsSync(full) && fs.statSync(full).size > 0, `Missing or empty build artifact: ${rel}`);
      }
    });
  });
});
