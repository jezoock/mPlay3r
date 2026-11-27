import { Component, Event, EventEmitter, h, Host, Prop } from '@stencil/core';
import { formatTime, formatTotalDuration } from '../../core';
import type { PlaybackStatus, Track } from '../../core';

/**
 * Filterable, reorderable playlist panel powered by dot-stash `ds-sortable`, `ds-trigger`, and `ds-badge`.
 */
@Component({
  tag: 'mp-playlist',
  styleUrl: 'mp-playlist.scss',
})
export class MpPlaylist {
  @Prop() playerTarget!: string;
  @Prop() tracks: Track[] = [];
  @Prop() totalCount = 0;
  @Prop() currentTrackId?: string;
  @Prop() status: PlaybackStatus = 'stopped';
  @Prop() filterQuery = '';

  @Event() mpFilterChange!: EventEmitter<string>;
  @Event() mpReorder!: EventEmitter<string[]>;

  private handleOrderChange = (event: CustomEvent<{ keys: string[] }>) => {
    if (Array.isArray(event.detail?.keys)) {
      this.mpReorder.emit(event.detail.keys);
    }
  };

  render() {
    const totalDuration = formatTotalDuration(this.tracks.map(t => t.duration));
    const isFiltered = this.filterQuery.trim().length > 0;

    return (
      <Host class="mp-playlist" role="region" aria-label="Playlist">
        <div class="mp-playlist__toolbar">
          <div class="mp-playlist__summary">
            <span class="mp-playlist__heading">Playlist</span>
            <ds-badge type="neutral" count={this.totalCount} />
            <span class="mp-playlist__total">{totalDuration}</span>
          </div>

          <div class="mp-playlist__actions" role="group" aria-label="Playlist actions">
            <ds-tooltip>
              <ds-trigger mods="mp-icon" target={this.playerTarget} action="openFilePicker" label="Add audio files">
                <ds-icon type="plus" />
              </ds-trigger>
              <span slot="message">Add files</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger mods="mp-icon" target={this.playerTarget} action="openFolderPicker" label="Add folder">
                <ds-icon type="folder-open" />
              </ds-trigger>
              <span slot="message">Add folder</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger mods="mp-icon" target={this.playerTarget} action="importPlaylistFile" label="Import M3U or PLS playlist">
                <ds-icon type="upload" />
              </ds-trigger>
              <span slot="message">Import M3U / PLS</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger
                mods="mp-icon"
                target={this.playerTarget}
                action="exportPlaylist"
                disabled={this.totalCount === 0}
                label="Export M3U8 playlist"
              >
                <ds-icon type="download" />
              </ds-trigger>
              <span slot="message">Export M3U8</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger
                mods="mp-icon"
                target={this.playerTarget}
                action="clearPlaylist"
                disabled={this.totalCount === 0}
                label="Clear playlist"
              >
                <ds-icon type="delete" />
              </ds-trigger>
              <span slot="message">Clear playlist</span>
            </ds-tooltip>
          </div>
        </div>

        {this.totalCount > 0 && (
          <div class="mp-playlist__search">
            <ds-icon class="mp-playlist__search-icon" type="search" />
            <input
              class="mp-playlist__search-input"
              type="search"
              placeholder="Filter tracks, artists, formats…"
              value={this.filterQuery}
              aria-label="Filter playlist"
              onInput={event => this.mpFilterChange.emit((event.target as HTMLInputElement).value)}
            />
          </div>
        )}

        <div class="mp-playlist__body">
          {this.totalCount === 0 ? (
            <div class="mp-playlist__empty">
              <p class="mp-playlist__empty-text">No tracks in playlist yet. Drop audio files here or add files below.</p>
              <div class="mp-playlist__empty-actions">
                <ds-trigger type="button" mods="sm,stl-1" target={this.playerTarget} action="openFilePicker">
                  Open files
                </ds-trigger>
                <ds-trigger type="button" mods="sm,stl-2" target={this.playerTarget} action="openFolderPicker">
                  Open folder
                </ds-trigger>
              </div>
            </div>
          ) : this.tracks.length === 0 && isFiltered ? (
            <div class="mp-playlist__empty">
              <p class="mp-playlist__empty-text">No tracks match "{this.filterQuery}".</p>
            </div>
          ) : (
            <ds-sortable
              class="mp-playlist__list"
              label="Playlist tracks"
              buttons={!isFiltered}
              onOrderChange={this.handleOrderChange}
            >
              {this.tracks.map((track, idx) => {
                const isActive = track.id === this.currentTrackId;
                const isPlaying = isActive && this.status === 'playing';
                return (
                  <div
                    class={{ 'mp-track': true, '--active': isActive, '--playing': isPlaying }}
                    key={track.id}
                    data-key={track.id}
                    data-label={track.artist ? `${track.artist} - ${track.title}` : track.title}
                  >
                    <ds-trigger
                      mods="mp-track-main"
                      target={this.playerTarget}
                      action={`playTrack:${JSON.stringify([track.id])}`}
                      label={`Play ${track.artist ? `${track.artist} — ` : ''}${track.title}`}
                    >
                      <span class="mp-track__index">
                        {isPlaying ? <ds-icon type="play" /> : String(idx + 1).padStart(2, '0')}
                      </span>
                      <span class="mp-track__info">
                        <span class="mp-track__title">{track.title}</span>
                        {track.artist && <span class="mp-track__artist">{track.artist}</span>}
                      </span>
                      <span class="mp-track__duration">{track.duration ? formatTime(track.duration) : '--:--'}</span>
                    </ds-trigger>

                    <ds-trigger
                      mods="mp-track-remove"
                      target={this.playerTarget}
                      action={`removeTrack:${JSON.stringify([track.id])}`}
                      label={`Remove ${track.title}`}
                    >
                      <ds-icon type="cancel" />
                    </ds-trigger>
                  </div>
                );
              })}
            </ds-sortable>
          )}
        </div>
      </Host>
    );
  }
}
