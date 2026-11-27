import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createTauriPlatformBridge,
  getDefaultPlatformBridge,
  getDesktopAppInfo,
  getLanShareStatus,
  initDesktopRuntime,
  isDesktopRuntime,
  pickDesktopAudioFiles,
  pickDesktopAudioFolder,
  pickDesktopPlaylistFile,
  resetDesktopRuntime,
  resolveDesktopAudioPaths,
  saveDesktopPlaylistFile,
  startLanShareServer,
  stopLanShareServer,
  writeDesktopAudioTags,
} from '../src/core/desktop-bridge';
import { createDefaultPersistedState, loadPersistedState, savePersistedState } from '../src/core/storage';

const root = fileURLToPath(new URL('..', import.meta.url));
const originalWindow = (globalThis as { window?: unknown }).window;

function installMockTauri(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): void {
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: { invoke },
  };
}

function uninstallMockWindow(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

afterEach(() => {
  resetDesktopRuntime();
  uninstallMockWindow();
});

describe('PR #6 & PR #18 Tauri v2 desktop bridge, LAN Share & ID3 tag writer IPC', () => {
  it('returns safe Web fallbacks when __TAURI_INTERNALS__ is absent', async () => {
    uninstallMockWindow();
    assert.equal(isDesktopRuntime(), false);
    assert.equal(initDesktopRuntime(), false);
    assert.equal(getDefaultPlatformBridge(), undefined);

    assert.deepEqual(await getDesktopAppInfo(), { isDesktop: false, isPortable: false });
    assert.equal(await pickDesktopAudioFiles(), null);
    assert.equal(await pickDesktopAudioFolder(), null);
    assert.deepEqual(await resolveDesktopAudioPaths([]), []);
    assert.equal(await resolveDesktopAudioPaths(['/music/a.flac']), null);
    assert.equal(await pickDesktopPlaylistFile(), null);
    assert.equal(await saveDesktopPlaylistFile('#EXTM3U\n'), false);
    assert.equal(
      await startLanShareServer({
        serverName: 'Test',
        port: 8765,
        bindAddress: '0.0.0.0',
        sharedFolders: ['/music'],
        pin: '123456',
        bearerToken: 'token-0123456789abcdef',
      }),
      null,
    );
    assert.equal(await stopLanShareServer(), false);
    assert.equal(await getLanShareStatus(), null);
    assert.equal(await writeDesktopAudioTags('/music/a.mp3', { title: 'Test' }), null);
  });

  it('invokes every Tauri v2 IPC command with the expected arguments and wires PlatformBridge + StorageAdapter', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    let persistedJson: string | null = null;

    installMockTauri(async (cmd, args) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case 'get_app_info':
          return { isDesktop: true, isPortable: true, dataDir: '/usb/mPlay3r/data', version: '0.1.0' };
        case 'pick_audio_files':
          return [{ path: '/music/01.flac', url: 'mplay3r://localhost/%2Fmusic%2F01.flac', name: '01.flac' }];
        case 'pick_audio_folder':
          return [{ path: '/music/album/02.mp3', url: 'mplay3r://localhost/%2Fmusic%2Falbum%2F02.mp3', name: '02.mp3' }];
        case 'resolve_audio_paths':
          return [{ path: '/music/saved.ogg', url: 'mplay3r://localhost/%2Fmusic%2Fsaved.ogg', name: 'saved.ogg' }];
        case 'pick_playlist_file':
          return { name: 'mix.m3u8', content: '#EXTM3U\n/music/saved.ogg\n' };
        case 'save_playlist_file':
          return true;
        case 'save_persisted_state':
          persistedJson = String(args?.json ?? '');
          return true;
        case 'load_persisted_state':
          return persistedJson;
        case 'start_lan_share_server':
          return {
            running: true,
            url: 'http://192.168.1.42:8765',
            serverName: 'Studio Desktop',
            port: 8765,
            folderCount: 1,
            trackCount: 42,
          };
        case 'get_lan_share_status':
          return {
            running: true,
            url: 'http://192.168.1.42:8765',
            serverName: 'Studio Desktop',
            port: 8765,
            folderCount: 1,
            trackCount: 42,
          };
        case 'stop_lan_share_server':
          return true;
        case 'write_audio_tags':
          return {
            path: '/music/album/02.mp3',
            updatedFrames: ['TIT2', 'TPE1'],
            bytesWritten: 2048,
          };
        default:
          throw new Error(`Unexpected IPC command: ${cmd}`);
      }
    });

    assert.equal(isDesktopRuntime(), true);
    assert.equal(initDesktopRuntime(), true);

    const bridge = getDefaultPlatformBridge() ?? createTauriPlatformBridge();
    assert.equal(bridge.isDesktop(), true);

    const info = await bridge.getAppInfo();
    assert.deepEqual(info, { isDesktop: true, isPortable: true, dataDir: '/usb/mPlay3r/data', version: '0.1.0' });

    const files = await bridge.pickAudioFiles();
    assert.equal(files?.length, 1);
    assert.equal(files?.[0].name, '01.flac');

    const folderFiles = await bridge.pickAudioFolder();
    assert.equal(folderFiles?.[0].name, '02.mp3');

    assert.deepEqual(await bridge.resolveAudioPaths([]), []);
    const resolved = await bridge.resolveAudioPaths(['/music/saved.ogg']);
    assert.equal(resolved?.[0].url, 'mplay3r://localhost/%2Fmusic%2Fsaved.ogg');

    const pickedPl = await bridge.pickPlaylistFile();
    assert.equal(pickedPl?.name, 'mix.m3u8');

    const exported = await bridge.savePlaylistFile('#EXTM3U\n', 'portable.m3u8');
    assert.equal(exported, true);

    // Verify StorageAdapter was automatically switched to Tauri portable JSON persistence.
    const state = { ...createDefaultPersistedState(), volume: 0.42, palette: 'amber' as const };
    await savePersistedState(state);
    assert.ok(persistedJson?.includes('"amber"'));
    const restored = await loadPersistedState();
    assert.equal(restored.volume, 0.42);
    assert.equal(restored.palette, 'amber');

    // PR #18 native LAN Share & ID3 tag writer IPC commands
    const lanConfig = {
      serverName: 'Studio Desktop',
      port: 8765,
      bindAddress: '0.0.0.0',
      sharedFolders: ['/music'],
      pin: '654321',
      bearerToken: 'token-0123456789abcdef',
    };
    const started = await bridge.startLanShareServer?.(lanConfig);
    assert.equal(started?.running, true);
    assert.equal(started?.url, 'http://192.168.1.42:8765');

    const status = await bridge.getLanShareStatus?.();
    assert.equal(status?.trackCount, 42);

    const stopped = await bridge.stopLanShareServer?.();
    assert.equal(stopped, true);

    const tagRes = await bridge.writeAudioTags?.('/music/album/02.mp3', {
      title: 'Voyager',
      artist: 'Daft Punk',
    });
    assert.deepEqual(tagRes?.updatedFrames, ['TIT2', 'TPE1']);

    const invokedNames = calls.map(c => c.cmd);
    assert.deepEqual(invokedNames, [
      'get_app_info',
      'pick_audio_files',
      'pick_audio_folder',
      'resolve_audio_paths',
      'pick_playlist_file',
      'save_playlist_file',
      'save_persisted_state',
      'load_persisted_state',
      'start_lan_share_server',
      'get_lan_share_status',
      'stop_lan_share_server',
      'write_audio_tags',
    ]);
    assert.deepEqual(calls[3].args, { paths: ['/music/saved.ogg'] });
    assert.deepEqual(calls[5].args, { content: '#EXTM3U\n', defaultName: 'portable.m3u8' });
    assert.deepEqual(calls[8].args, { config: lanConfig });
    assert.deepEqual(calls[11].args, {
      path: '/music/album/02.mp3',
      tags: { title: 'Voyager', artist: 'Daft Punk' },
    });
  });

  it('ships valid Tauri v2 configuration, least-privilege capabilities, icons, and size-optimized Cargo profile', () => {
    const tauriDir = path.join(root, 'src-tauri');
    const conf = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8')) as {
      productName: string;
      build: { frontendDist: string };
      app: { security: { csp: string } };
      bundle: { icon: string[] };
    };

    assert.equal(conf.productName, 'mPlay3r');
    assert.equal(conf.build.frontendDist, '../www');
    assert.ok(conf.app.security.csp.includes('mplay3r:'), 'CSP must allow mplay3r:// custom audio protocol');
    for (const iconRel of conf.bundle.icon) {
      const full = path.join(tauriDir, iconRel);
      assert.ok(fs.existsSync(full) && fs.statSync(full).size > 0, `Missing Tauri icon: src-tauri/${iconRel}`);
    }

    const cap = JSON.parse(fs.readFileSync(path.join(tauriDir, 'capabilities', 'default.json'), 'utf8')) as {
      windows: string[];
      permissions: string[];
    };
    assert.deepEqual(cap.windows, ['main']);
    assert.ok(cap.permissions.includes('core:default'));
    assert.ok(cap.permissions.includes('dialog:default'));

    const cargoToml = fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8');
    assert.match(cargoToml, /opt-level\s*=\s*"s"/, 'Release profile must optimize for minimal binary size');
    assert.match(cargoToml, /lto\s*=\s*true/, 'Release profile must enable LTO');
    assert.match(cargoToml, /strip\s*=\s*true/, 'Release profile must strip debug symbols');
  });
});
