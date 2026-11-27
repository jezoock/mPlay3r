import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlaylistStore } from '../src/core/playlist-store';

describe('PlaylistStore', () => {
  it('adds tracks, tracks current selection, and filters by query', () => {
    const store = new PlaylistStore();
    const added = store.addTracks([
      { id: 'a', src: 'a.mp3', title: 'Sunrise', artist: 'Alpha' },
      { id: 'b', src: 'b.flac', title: 'Midnight', artist: 'Beta' },
      { id: 'c', src: 'c.ogg', title: 'Dawn', artist: 'Alpha' },
    ]);

    assert.equal(added.length, 3);
    assert.equal(store.getCurrentIndex(), 0);
    assert.equal(store.getCurrentTrack()?.id, 'a');
    assert.equal(store.getFilteredTracks('alpha').length, 2);
    assert.equal(store.getFilteredTracks('flac').length, 1);
  });

  it('handles repeat off, all, and one transitions cleanly', () => {
    const store = new PlaylistStore();
    store.addTracks([
      { id: '1', src: '1.mp3', title: 'One' },
      { id: '2', src: '2.mp3', title: 'Two' },
    ]);

    assert.equal(store.next(true).track?.id, '2');
    assert.equal(store.next(true).action, 'stop');

    store.setRepeat('all');
    assert.equal(store.next(true).track?.id, '1');

    store.setRepeat('one');
    const repeatOne = store.next(true);
    assert.equal(repeatOne.action, 'restart');
    assert.equal(repeatOne.track?.id, '1');

    // Manual next still advances even in repeat-one mode.
    const manualNext = store.next(false);
    assert.equal(manualNext.action, 'play');
    assert.equal(manualNext.track?.id, '2');
  });

  it('implements Winamp previous behavior (>3s restarts current track)', () => {
    const store = new PlaylistStore();
    store.addTracks([
      { id: '1', src: '1.mp3', title: 'One' },
      { id: '2', src: '2.mp3', title: 'Two' },
    ]);
    store.selectTrack(1);

    assert.equal(store.previous(8).action, 'restart');
    assert.equal(store.getCurrentTrack()?.id, '2');

    const prev = store.previous(1.2);
    assert.equal(prev.action, 'play');
    assert.equal(prev.track?.id, '1');
  });

  it('reorders tracks via ds-sortable ids while preserving active track pointer', () => {
    const store = new PlaylistStore();
    store.addTracks([
      { id: 't1', src: '1.mp3', title: 'One' },
      { id: 't2', src: '2.mp3', title: 'Two' },
      { id: 't3', src: '3.mp3', title: 'Three' },
    ]);
    store.selectTrack('t2');

    store.reorderByIds(['t3', 't1', 't2']);
    assert.deepEqual(
      store.getTracks().map(t => t.id),
      ['t3', 't1', 't2'],
    );
    assert.equal(store.getCurrentIndex(), 2);
    assert.equal(store.getCurrentTrack()?.id, 't2');
  });

  it('revokes object URLs on remove and clear', () => {
    const revoked: string[] = [];
    const store = new PlaylistStore({ revokeUrl: url => revoked.push(url) });
    store.addTracks([
      { id: 'b1', src: 'blob:track-1', title: 'Blob 1', isObjectUrl: true },
      { id: 'b2', src: 'blob:track-2', title: 'Blob 2', isObjectUrl: true },
      { id: 'r1', src: 'https://example.com/3.mp3', title: 'Remote' },
    ]);

    store.removeTrack('b1');
    assert.deepEqual(revoked, ['blob:track-1']);
    assert.equal(store.getCurrentTrack()?.id, 'b2');

    store.clear();
    assert.deepEqual(revoked, ['blob:track-1', 'blob:track-2']);
    assert.equal(store.getCurrentTrack(), null);
  });

  it('visits every track once in shuffle mode and preserves filtered-out tracks on reorder', () => {
    const store = new PlaylistStore();
    store.addTracks([
      { id: '1', src: '1.mp3', title: 'Alpha' },
      { id: '2', src: '2.mp3', title: 'Beta' },
      { id: '3', src: '3.mp3', title: 'Gamma' },
      { id: '4', src: '4.mp3', title: 'Delta' },
    ]);

    store.setShuffle(true);
    const visited = new Set<string>();
    const first = store.getCurrentTrack();
    assert.ok(first);
    visited.add(first.id);

    for (let i = 0; i < 3; i += 1) {
      const step = store.next(true);
      assert.equal(step.action, 'play');
      assert.ok(step.track);
      visited.add(step.track.id);
    }
    assert.equal(visited.size, 4);
    assert.equal(store.next(true).action, 'stop');

    // Partial reorder (e.g. while filtered) keeps omitted tracks at the end in relative order.
    store.setShuffle(false);
    store.reorderByIds(['4', '2']);
    assert.deepEqual(
      store.getTracks().map(t => t.id),
      ['4', '2', '1', '3'],
    );
  });
});
