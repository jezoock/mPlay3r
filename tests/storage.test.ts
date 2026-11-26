import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultPersistedState, loadPersistedState, sanitizePersistedState, savePersistedState } from '../src/core/storage';
import type { StorageAdapter } from '../src/core/storage';

describe('storage state sanitization & persistence adapter', () => {
  it('returns safe defaults on null or invalid input', () => {
    const defaults = createDefaultPersistedState();
    assert.deepEqual(sanitizePersistedState(null), defaults);
    assert.deepEqual(sanitizePersistedState('corrupted'), defaults);
  });

  it('clamps out-of-range numeric values and rejects invalid palette or repeat modes', () => {
    const clean = sanitizePersistedState({
      volume: 5,
      balance: -99,
      repeat: 'invalid-mode',
      palette: 'neon-pink',
      equalizer: {
        enabled: false,
        preamp: 42,
        bands: [20, -25, 0, 1, 2, 3, 4, 5, 6, 7],
        preset: 'custom',
      },
      savedTracks: [{ src: '/music/ok.flac' }, { title: 'missing-src' }],
    });

    assert.equal(clean.volume, 1);
    assert.equal(clean.balance, -1);
    assert.equal(clean.repeat, 'off');
    assert.equal(clean.palette, 'obsidian');
    assert.equal(clean.equalizer.enabled, false);
    assert.equal(clean.equalizer.preamp, 12);
    assert.equal(clean.equalizer.bands[0], 12);
    assert.equal(clean.equalizer.bands[1], -12);
    assert.equal(clean.savedTracks?.length, 1);
  });

  it('round-trips persisted state through a pluggable StorageAdapter and recovers from invalid JSON', async () => {
    let raw: string | null = null;
    const memoryAdapter: StorageAdapter = {
      async load() {
        return raw;
      },
      async save(json) {
        raw = json;
      },
    };

    const custom = {
      ...createDefaultPersistedState(),
      volume: 0.42,
      palette: 'amber' as const,
      repeat: 'all' as const,
    };

    await savePersistedState(custom, memoryAdapter);
    const loaded = await loadPersistedState(memoryAdapter);
    assert.equal(loaded.volume, 0.42);
    assert.equal(loaded.palette, 'amber');
    assert.equal(loaded.repeat, 'all');

    raw = '{not valid json';
    const recovered = await loadPersistedState(memoryAdapter);
    assert.deepEqual(recovered, createDefaultPersistedState());
  });
});
