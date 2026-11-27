import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { DEFAULT_EQUALIZER_STATE } from '../src/core/constants';
import type { PlayerSnapshot } from '../src/core/types';
import {
  createMemoryPluginStorage,
  DEFAULT_PLUGIN_REGISTRY_URL,
  extractZipEntries,
  filterStoreCatalog,
  formatByteSize,
  isAllowedRemoteUrl,
  parseLocalPluginZip,
  parseRegistryDocument,
  PluginHost,
  PluginIntegrityError,
  PluginStore,
  PluginValidationError,
  resolveRegistryEntryUrl,
  sha256Hex,
  verifySha256,
} from '../src/plugins';
import type { MPlay3rPlugin, PluginHostAdapter, PluginManifest } from '../src/plugins';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Minimal ZIP builder (Stored method 0 or Deflate method 8) for testing local .zip plugin imports. */
function buildZip(entries: Array<{ name: string; data: Uint8Array | string; deflate?: boolean }>): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let offset = 0;

  for (const item of entries) {
    const nameBytes = encoder.encode(item.name);
    const rawBytes = typeof item.data === 'string' ? encoder.encode(item.data) : item.data;
    const payload = item.deflate ? new Uint8Array(deflateRawSync(rawBytes)) : rawBytes;
    const method = item.deflate ? 8 : 0;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, rawBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    localChunks.push(lfh, payload);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, rawBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);
    cdChunks.push(cdh);

    offset += lfh.length + payload.length;
  }

  const cdOffset = offset;
  const cdSize = cdChunks.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const all = [...localChunks, ...cdChunks, eocd];
  const out = new Uint8Array(all.reduce((sum, c) => sum + c.length, 0));
  let pos = 0;
  for (const chunk of all) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function createHostAdapter(coreVersion = '0.1.0'): PluginHostAdapter {
  const snapshot: PlayerSnapshot = {
    status: 'stopped',
    currentTrack: null,
    currentIndex: -1,
    tracks: [],
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 0.85,
    muted: false,
    balance: 0,
    shuffle: false,
    repeat: 'off',
    showRemaining: false,
    equalizer: { ...DEFAULT_EQUALIZER_STATE, bands: [...DEFAULT_EQUALIZER_STATE.bands] },
    palette: 'obsidian',
    showEqualizer: false,
    showPlaylist: true,
    compact: false,
  };

  return {
    coreVersion,
    getPlayerTarget: () => '#mplay3r',
    getState: () => snapshot,
    playback: {
      play: async () => undefined,
      pause: async () => undefined,
      togglePlay: async () => undefined,
      stop: async () => undefined,
      next: async () => undefined,
      previous: async () => undefined,
      seek: async () => undefined,
      setVolume: async () => undefined,
      getStatus: () => 'stopped',
    },
    playlist: {
      addTracks: async () => [],
      removeTrack: async () => undefined,
      clearPlaylist: async () => undefined,
    },
    updateTrackMetadata: async () => true,
    getAudioAnalyser: async () => null,
    getAudioContext: async () => null,
    notify: async () => undefined,
  };
}

describe('PR #8 Integrated Plugin Store & SHA-256 Registry', () => {
  describe('SHA-256 cryptographic integrity verification', () => {
    it('matches standard SHA-256 test vectors and strictly rejects altered bytes', async () => {
      assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

      const bundle = new TextEncoder().encode('export default { manifest: {}, activate() {} };');
      const digest = await sha256Hex(bundle);

      const valid = await verifySha256(bundle, digest.toUpperCase());
      assert.equal(valid.ok, true);
      assert.equal(valid.actual, digest);

      const tampered = new Uint8Array(bundle);
      tampered[0] ^= 0x01;
      const bad = await verifySha256(tampered, digest);
      assert.equal(bad.ok, false);
      assert.notEqual(bad.actual, digest);

      const malformed = await verifySha256(bundle, 'not-a-sha256');
      assert.equal(malformed.ok, false);
    });
  });

  describe('JSON registry validation, URL safety & filtering', () => {
    it('parses valid v1 registries, resolves relative entries, and skips unsigned or unsafe entries', () => {
      const validHash = 'a'.repeat(64);
      const parsed = parseRegistryDocument(
        {
          schemaVersion: 1,
          name: 'mPlay3r Official Addons',
          plugins: [
            {
              id: 'mplay3r.radio',
              name: 'Web Radio',
              version: '1.0.0',
              description: 'Stream web and FM IP radios',
              category: 'source',
              permissions: ['network', 'playlist-write', 'ui-slot'],
              entry: './plugins/radio/index.js',
              sha256: validHash,
              sizeBytes: 6144,
            },
            {
              id: 'mplay3r.unsigned',
              name: 'Unsigned Plugin',
              version: '1.0.0',
              description: 'Missing sha256 must be rejected',
              category: 'dsp',
              permissions: [],
              entry: './plugins/unsigned.js',
            },
            {
              id: 'mplay3r.unsafe',
              name: 'Unsafe Scheme',
              version: '1.0.0',
              description: 'Javascript scheme must be rejected',
              category: 'theme',
              permissions: ['theme'],
              entry: 'javascript:alert(1)',
              sha256: validHash,
            },
          ],
        },
        DEFAULT_PLUGIN_REGISTRY_URL,
      );

      assert.equal(parsed.valid, true);
      assert.equal(parsed.registry?.plugins.length, 1);
      assert.equal(parsed.registry?.plugins[0].id, 'mplay3r.radio');
      assert.equal(parsed.errors.length, 2);

      assert.equal(
        resolveRegistryEntryUrl('./plugins/radio/index.js', DEFAULT_PLUGIN_REGISTRY_URL),
        'https://raw.githubusercontent.com/jezoock/mPlay3r-addons/main/plugins/radio/index.js',
      );
      assert.equal(isAllowedRemoteUrl('https://example.com/registry.json'), true);
      assert.equal(isAllowedRemoteUrl('http://localhost:8080/registry.json'), true);
      assert.equal(isAllowedRemoteUrl('http://insecure.example/registry.json'), false);
      assert.equal(isAllowedRemoteUrl('file:///etc/passwd'), false);

      assert.equal(formatByteSize(512), '512 B');
      assert.equal(formatByteSize(6144), '6.0 KB');
      assert.equal(formatByteSize(2 * 1024 * 1024), '2.00 MB');
    });

    it('filters store catalog by category, query, and compatibility', () => {
      const makeItem = (id: string, category: PluginManifest['category'], compatible: boolean) => ({
        manifest: {
          id,
          name: `Plugin ${id}`,
          version: '1.0.0',
          description: `Description for ${category}`,
          category,
          permissions: ['network' as const],
          entry: './index.js',
          sha256: 'b'.repeat(64),
        },
        registryUrl: DEFAULT_PLUGIN_REGISTRY_URL,
        registryName: 'Official',
        resolvedEntryUrl: 'https://example.com/index.js',
        compatible,
        updateAvailable: false,
        status: 'available' as const,
      });

      const items = [
        makeItem('radio', 'source', true),
        makeItem('spectrum', 'visualizer', true),
        makeItem('future-dsp', 'dsp', false),
      ];

      assert.equal(filterStoreCatalog(items, { category: 'visualizer' }).length, 1);
      assert.equal(filterStoreCatalog(items, { query: 'spectrum' }).length, 1);
      assert.equal(filterStoreCatalog(items, { onlyCompatible: true }).length, 2);
    });
  });

  describe('PluginStore SHA-256 install, tamper protection, compatibility & updates', () => {
    it('installs on valid SHA-256, strictly blocks tampered bytes, enforces minCoreVersion, and performs updates', async () => {
      const storage = createMemoryPluginStorage();
      const host = new PluginHost(createHostAdapter('0.1.0'), storage);

      const bundleV1 = new TextEncoder().encode('// mplay3r.radio v1.0.0');
      const bundleV2 = new TextEncoder().encode('// mplay3r.radio v1.1.0');
      const tamperedBytes = new TextEncoder().encode('// MALICIOUS TAMPERED PAYLOAD');
      const hashV1 = await sha256Hex(bundleV1);
      const hashV2 = await sha256Hex(bundleV2);

      let servedVersion: '1.0.0' | '1.1.0' = '1.0.0';
      let serveTampered = false;
      let loaderInvocations = 0;

      const mockFetch = (async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith('registry.json')) {
          const isV2 = servedVersion === '1.1.0';
          return {
            ok: true,
            status: 200,
            json: async () => ({
              schemaVersion: 1,
              name: 'Official Addons',
              plugins: [
                {
                  id: 'mplay3r.radio',
                  name: 'Web Radio',
                  version: servedVersion,
                  description: 'Web & FM IP radios',
                  category: 'source',
                  permissions: ['network'],
                  minCoreVersion: '0.1.0',
                  entry: isV2 ? './radio-v2.js' : './radio-v1.js',
                  sha256: isV2 ? hashV2 : hashV1,
                  sizeBytes: (isV2 ? bundleV2 : bundleV1).byteLength,
                },
                {
                  id: 'mplay3r.future',
                  name: 'Future Only',
                  version: '2.0.0',
                  description: 'Needs core 9.0.0',
                  category: 'dsp',
                  permissions: [],
                  minCoreVersion: '9.0.0',
                  entry: './future.js',
                  sha256: hashV1,
                },
              ],
            }),
          } as unknown as Response;
        }
        if (href.endsWith('radio-v1.js')) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => (serveTampered ? tamperedBytes : bundleV1).buffer,
          } as unknown as Response;
        }
        if (href.endsWith('radio-v2.js')) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => bundleV2.buffer,
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      }) as typeof fetch;

      let activatedVersion = '';
      const mockLoader = async (_bytes: Uint8Array, hint?: PluginManifest): Promise<MPlay3rPlugin> => {
        loaderInvocations += 1;
        return {
          manifest: hint!,
          activate() {
            activatedVersion = hint!.version;
          },
        };
      };

      const store = new PluginStore({
        coreVersion: '0.1.0',
        storageBackend: storage,
        fetcher: mockFetch,
        moduleLoader: mockLoader,
      });

      const { items } = await store.refreshCatalog(host.getPlugins());
      assert.equal(items.length, 2);
      const radioItem = items.find(i => i.manifest.id === 'mplay3r.radio')!;
      const futureItem = items.find(i => i.manifest.id === 'mplay3r.future')!;
      assert.equal(radioItem.compatible, true);
      assert.equal(futureItem.compatible, false);

      // 1. Incompatible minCoreVersion is rejected BEFORE download or load.
      await assert.rejects(() => store.installFromCatalog(futureItem, host), PluginValidationError);
      assert.equal(loaderInvocations, 0);

      // 2. Tampered remote bundle is rejected by SHA-256 BEFORE moduleLoader ever runs!
      serveTampered = true;
      await assert.rejects(() => store.installFromCatalog(radioItem, host), PluginIntegrityError);
      assert.equal(loaderInvocations, 0, 'Tampered bundle must NEVER reach moduleLoader');
      assert.equal(host.getPlugins().length, 0);

      // 3. Authentic bundle passes SHA-256 verification and activates in PluginHost.
      serveTampered = false;
      const installed = await store.installFromCatalog(radioItem, host);
      assert.equal(installed.status, 'active');
      assert.equal(activatedVersion, '1.0.0');
      assert.equal(loaderInvocations, 1);

      // 4. Newer version in registry surfaces updateAvailable and upgrades cleanly.
      servedVersion = '1.1.0';
      const refreshed = await store.refreshCatalog(host.getPlugins());
      const radioV2 = refreshed.items.find(i => i.manifest.id === 'mplay3r.radio')!;
      assert.equal(radioV2.updateAvailable, true);
      assert.equal(radioV2.installedVersion, '1.0.0');

      const updated = await store.installFromCatalog(radioV2, host);
      assert.equal(updated.manifest.version, '1.1.0');
      assert.equal(activatedVersion, '1.1.0');
    });

    it('rejects manifest substitution and persists custom third-party registries', async () => {
      const storage = createMemoryPluginStorage();
      const host = new PluginHost(createHostAdapter('0.1.0'), storage);
      const bytes = new TextEncoder().encode('// spoofed');
      const digest = await sha256Hex(bytes);

      const store = new PluginStore({
        coreVersion: '0.1.0',
        storageBackend: storage,
        fetcher: (async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }) as unknown as Response) as typeof fetch,
        moduleLoader: async () => ({
          manifest: {
            id: 'mplay3r.impostor',
            name: 'Impostor',
            version: '1.0.0',
            description: 'Wrong id',
            category: 'source',
            permissions: [],
          },
          activate() {},
        }),
      });

      await assert.rejects(
        () =>
          store.installFromCatalog(
            {
              manifest: {
                id: 'mplay3r.expected',
                name: 'Expected',
                version: '1.0.0',
                description: 'Signed entry',
                category: 'source',
                permissions: [],
                entry: './ok.js',
                sha256: digest,
              },
              registryUrl: DEFAULT_PLUGIN_REGISTRY_URL,
              registryName: 'Official',
              resolvedEntryUrl: 'https://example.com/ok.js',
              compatible: true,
              updateAvailable: false,
              status: 'available',
            },
            host,
          ),
        PluginValidationError,
      );

      // Third-party registry persistence & scheme guard.
      await assert.rejects(() => store.addRegistryUrl('http://evil.example/registry.json'));
      await store.addRegistryUrl('https://community.example/registry.json');
      await store.addRegistryUrl('http://localhost:4000/registry.json');

      const storeReloaded = new PluginStore({ coreVersion: '0.1.0', storageBackend: storage });
      const urls = await storeReloaded.getRegistryUrls();
      assert.ok(urls.includes('https://community.example/registry.json'));
      assert.ok(urls.includes('http://localhost:4000/registry.json'));
    });
  });

  describe('local .zip archive extraction & import', () => {
    it('extracts stored and deflate ZIP archives, verifies SHA-256, and rejects tampered or incomplete archives', async () => {
      const code = new TextEncoder().encode('export default { id: "local-vis" };');
      const codeHash = await sha256Hex(code);
      const manifest: PluginManifest = {
        id: 'mplay3r.local-vis',
        name: 'Local Visualizer',
        version: '0.5.0',
        description: 'Imported from local zip',
        category: 'visualizer',
        permissions: ['audio-analyser', 'ui-slot'],
        entry: 'index.js',
        sha256: codeHash,
      };

      // Deflate-compressed ZIP (method 8).
      const zipDeflate = buildZip([
        { name: 'manifest.json', data: JSON.stringify(manifest), deflate: true },
        { name: 'index.js', data: code, deflate: true },
      ]);
      const extracted = await parseLocalPluginZip(zipDeflate);
      assert.equal(extracted.manifest.id, 'mplay3r.local-vis');
      assert.deepEqual(extracted.entrySource, code);

      // End-to-end import into PluginStore + PluginHost.
      const host = new PluginHost(createHostAdapter('0.1.0'), createMemoryPluginStorage());
      const store = new PluginStore({
        coreVersion: '0.1.0',
        storageBackend: createMemoryPluginStorage(),
        moduleLoader: async (_bytes, hint) => ({ manifest: hint!, activate() {} }),
      });
      const rec = await store.installFromLocalFile(
        { name: 'local-vis.zip', arrayBuffer: async () => zipDeflate.buffer.slice(zipDeflate.byteOffset, zipDeflate.byteOffset + zipDeflate.byteLength) as ArrayBuffer },
        host,
      );
      assert.equal(rec.status, 'active');

      // Tampered entry inside ZIP fails SHA-256 check.
      const tamperedZip = buildZip([
        { name: 'manifest.json', data: JSON.stringify(manifest) },
        { name: 'index.js', data: 'tampered code' },
      ]);
      await assert.rejects(() => parseLocalPluginZip(tamperedZip), PluginIntegrityError);

      // Missing manifest.json rejected cleanly, and path-traversal entries ignored.
      const badZip = buildZip([{ name: '../escape.js', data: 'nope' }]);
      const entries = await extractZipEntries(badZip);
      assert.equal(entries.size, 0);
      await assert.rejects(() => parseLocalPluginZip(badZip), PluginValidationError);
    });
  });

  describe('<mp-store> component & ds-trigger wiring', () => {
    it('wires Store button via ds-trigger to toggleStore() and uses dot-stash components in <mp-store>', () => {
      const storeTsx = fs.readFileSync(path.join(root, 'src', 'components', 'mp-store', 'mp-store.tsx'), 'utf8');
      const headerTsx = fs.readFileSync(path.join(root, 'src', 'components', 'mp-header', 'mp-header.tsx'), 'utf8');
      const appTsx = fs.readFileSync(path.join(root, 'src', 'components', 'mplay3r-app', 'mplay3r-app.tsx'), 'utf8');

      assert.ok(headerTsx.includes('action="toggleStore"'), 'mp-header must toggle Store via ds-trigger');
      assert.match(appTsx, /@Method\(\)\s+async\s+toggleStore\s*\(/, 'mplay3r-app must expose toggleStore @Method()');
      assert.ok(appTsx.includes('<mp-store'), 'mplay3r-app must lazily render <mp-store>');
      assert.ok(storeTsx.includes('<ds-badge'), '<mp-store> should use dot-stash ds-badge');
      assert.ok(storeTsx.includes('<ds-toggle'), '<mp-store> should use dot-stash ds-toggle');
      assert.ok(storeTsx.includes('<ds-trigger'), '<mp-store> should use dot-stash ds-trigger');
      assert.ok(storeTsx.includes('accept=".zip,.js,.mjs"'), '<mp-store> must support local .zip/.js import');
    });
  });
});
