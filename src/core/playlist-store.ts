import { parseFilenameMetadata } from './metadata';
import type { RepeatMode, Track, TrackInput } from './types';

let trackSequence = 0;

function generateTrackId(): string {
  trackSequence += 1;
  return `mp-trk-${Date.now().toString(36)}-${trackSequence}`;
}

export interface NavigationResult {
  action: 'play' | 'restart' | 'stop' | 'none';
  track: Track | null;
  index: number;
}

/**
 * Pure playlist state machine: manages tracks, active index, shuffle order, repeat cycling,
 * search filtering, reordering (for ds-sortable), and blob URL cleanup.
 */
export class PlaylistStore {
  private tracks: Track[] = [];
  private currentIndex = -1;
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private shuffleOrder: number[] = [];
  private shuffleCursor = -1;
  private revokeUrl: (url: string) => void;

  constructor(options?: { revokeUrl?: (url: string) => void }) {
    this.revokeUrl =
      options?.revokeUrl ??
      (url => {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      });
  }

  getTracks(): Track[] {
    return [...this.tracks];
  }

  getFilteredTracks(query: string): Track[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.getTracks();
    }
    return this.tracks.filter(track => {
      const haystack = `${track.title} ${track.artist ?? ''} ${track.album ?? ''} ${track.format ?? ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrentTrack(): Track | null {
    return this.currentIndex >= 0 && this.currentIndex < this.tracks.length ? this.tracks[this.currentIndex] : null;
  }

  isShuffle(): boolean {
    return this.shuffle;
  }

  getRepeat(): RepeatMode {
    return this.repeat;
  }

  addTracks(inputs: readonly TrackInput[]): Track[] {
    const added: Track[] = [];
    for (const input of inputs) {
      if (!input?.src) {
        continue;
      }
      const fallback = parseFilenameMetadata(input.filePath || input.src);
      const track: Track = {
        id: input.id || generateTrackId(),
        src: input.src,
        title: input.title?.trim() || fallback.title,
        artist: input.artist?.trim() || fallback.artist,
        album: input.album?.trim() || undefined,
        duration: typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration >= 0 ? input.duration : undefined,
        format: input.format || fallback.format,
        filePath: input.filePath,
        isObjectUrl: input.isObjectUrl,
      };
      this.tracks.push(track);
      added.push(track);
    }

    if (this.currentIndex === -1 && this.tracks.length > 0) {
      this.currentIndex = 0;
    }
    if (this.shuffle) {
      this.rebuildShuffleOrder(this.currentIndex);
    }
    return added;
  }

  replaceTracks(inputs: readonly TrackInput[]): Track[] {
    this.clear();
    return this.addTracks(inputs);
  }

  removeTrack(id: string): { removed: boolean; wasCurrent: boolean; nextTrack: Track | null } {
    const index = this.tracks.findIndex(track => track.id === id);
    if (index === -1) {
      return { removed: false, wasCurrent: false, nextTrack: this.getCurrentTrack() };
    }

    const [removed] = this.tracks.splice(index, 1);
    if (removed?.isObjectUrl) {
      this.revokeUrl(removed.src);
    }

    const wasCurrent = index === this.currentIndex;
    if (this.tracks.length === 0) {
      this.currentIndex = -1;
    } else if (index < this.currentIndex) {
      this.currentIndex -= 1;
    } else if (wasCurrent) {
      this.currentIndex = Math.min(index, this.tracks.length - 1);
    }

    if (this.shuffle) {
      this.rebuildShuffleOrder(this.currentIndex);
    }

    return { removed: true, wasCurrent, nextTrack: this.getCurrentTrack() };
  }

  clear(): void {
    for (const track of this.tracks) {
      if (track.isObjectUrl) {
        this.revokeUrl(track.src);
      }
    }
    this.tracks = [];
    this.currentIndex = -1;
    this.shuffleOrder = [];
    this.shuffleCursor = -1;
  }

  /** Reorders tracks according to an array of track ids (emitted by ds-sortable `orderChange`). */
  reorderByIds(orderedIds: readonly string[]): boolean {
    if (orderedIds.length === 0 || this.tracks.length === 0) {
      return false;
    }
    const currentId = this.getCurrentTrack()?.id;
    const byId = new Map(this.tracks.map(track => [track.id, track]));
    const reordered: Track[] = [];
    const seen = new Set<string>();

    for (const id of orderedIds) {
      const track = byId.get(id);
      if (track && !seen.has(id)) {
        reordered.push(track);
        seen.add(id);
      }
    }
    // Preserve any tracks hidden by a search filter at the end in their original relative order.
    for (const track of this.tracks) {
      if (!seen.has(track.id)) {
        reordered.push(track);
      }
    }

    this.tracks = reordered;
    this.currentIndex = currentId ? this.tracks.findIndex(track => track.id === currentId) : this.tracks.length > 0 ? 0 : -1;
    if (this.shuffle) {
      this.rebuildShuffleOrder(this.currentIndex);
    }
    return true;
  }

  updateTrackMeta(id: string, patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'duration' | 'format'>>): boolean {
    const track = this.tracks.find(item => item.id === id);
    if (!track) {
      return false;
    }
    Object.assign(track, patch);
    return true;
  }

  selectTrack(indexOrId: number | string): Track | null {
    const index = typeof indexOrId === 'number' ? indexOrId : this.tracks.findIndex(track => track.id === indexOrId);
    if (index < 0 || index >= this.tracks.length) {
      return null;
    }
    this.currentIndex = index;
    if (this.shuffle) {
      const cursor = this.shuffleOrder.indexOf(index);
      if (cursor >= 0) {
        this.shuffleCursor = cursor;
      } else {
        this.rebuildShuffleOrder(index);
      }
    }
    return this.tracks[index];
  }

  setShuffle(enabled: boolean): boolean {
    this.shuffle = Boolean(enabled);
    if (this.shuffle) {
      this.rebuildShuffleOrder(this.currentIndex);
    } else {
      this.shuffleOrder = [];
      this.shuffleCursor = -1;
    }
    return this.shuffle;
  }

  toggleShuffle(): boolean {
    return this.setShuffle(!this.shuffle);
  }

  setRepeat(mode: RepeatMode): RepeatMode {
    this.repeat = mode;
    return this.repeat;
  }

  cycleRepeat(): RepeatMode {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    const next = order[(order.indexOf(this.repeat) + 1) % order.length];
    this.repeat = next;
    return next;
  }

  /** Computes the next track (used by both user Next click and automatic track-ended transition). */
  next(autoAdvance = false): NavigationResult {
    if (this.tracks.length === 0) {
      return { action: 'none', track: null, index: -1 };
    }

    if (autoAdvance && this.repeat === 'one') {
      const track = this.getCurrentTrack();
      return track ? { action: 'restart', track, index: this.currentIndex } : { action: 'stop', track: null, index: -1 };
    }

    if (this.shuffle) {
      if (this.shuffleOrder.length !== this.tracks.length) {
        this.rebuildShuffleOrder(this.currentIndex);
      }
      const nextCursor = this.shuffleCursor + 1;
      if (nextCursor < this.shuffleOrder.length) {
        this.shuffleCursor = nextCursor;
        this.currentIndex = this.shuffleOrder[nextCursor];
        return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
      }
      if (this.repeat === 'all') {
        this.rebuildShuffleOrder(-1);
        this.shuffleCursor = 0;
        this.currentIndex = this.shuffleOrder[0];
        return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
      }
      return { action: 'stop', track: null, index: this.currentIndex };
    }

    const nextIndex = this.currentIndex + 1;
    if (nextIndex < this.tracks.length) {
      this.currentIndex = nextIndex;
      return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
    }

    if (this.repeat === 'all' || (!autoAdvance && this.repeat === 'one')) {
      this.currentIndex = 0;
      return { action: 'play', track: this.tracks[0], index: 0 };
    }

    return { action: 'stop', track: null, index: this.currentIndex };
  }

  /**
   * Classic Winamp Previous behavior:
   * if playback is past 3 seconds, restart the current track; otherwise jump to the previous track.
   */
  previous(currentTime = 0): NavigationResult {
    if (this.tracks.length === 0) {
      return { action: 'none', track: null, index: -1 };
    }

    if (currentTime > 3 && this.getCurrentTrack()) {
      return { action: 'restart', track: this.getCurrentTrack(), index: this.currentIndex };
    }

    if (this.shuffle) {
      if (this.shuffleOrder.length !== this.tracks.length) {
        this.rebuildShuffleOrder(this.currentIndex);
      }
      if (this.shuffleCursor > 0) {
        this.shuffleCursor -= 1;
        this.currentIndex = this.shuffleOrder[this.shuffleCursor];
        return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
      }
      if (this.repeat === 'all') {
        this.shuffleCursor = this.shuffleOrder.length - 1;
        this.currentIndex = this.shuffleOrder[this.shuffleCursor];
        return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
      }
      return { action: 'restart', track: this.getCurrentTrack(), index: this.currentIndex };
    }

    if (this.currentIndex > 0) {
      this.currentIndex -= 1;
      return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
    }

    if (this.repeat === 'all') {
      this.currentIndex = this.tracks.length - 1;
      return { action: 'play', track: this.tracks[this.currentIndex], index: this.currentIndex };
    }

    return { action: 'restart', track: this.getCurrentTrack(), index: this.currentIndex };
  }

  private rebuildShuffleOrder(anchorIndex: number): void {
    const indices = this.tracks.map((_, idx) => idx).filter(idx => idx !== anchorIndex);
    // Fisher-Yates shuffle.
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    if (anchorIndex >= 0 && anchorIndex < this.tracks.length) {
      this.shuffleOrder = [anchorIndex, ...indices];
      this.shuffleCursor = 0;
    } else {
      this.shuffleOrder = indices;
      this.shuffleCursor = indices.length > 0 ? 0 : -1;
    }
  }
}
