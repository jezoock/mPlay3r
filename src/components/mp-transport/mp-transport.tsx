import { Component, Event, EventEmitter, h, Host, Prop, State } from '@stencil/core';
import { formatBalance, formatTime } from '../../core';
import type { PlaybackStatus, RepeatMode, Track } from '../../core';

interface RangeHostRef extends HTMLElement {
  refresh?: () => Promise<void>;
}

/**
 * Main Winamp-inspired minimalist transport deck.
 * Uses `<ds-trigger>` for all transport/mode buttons and `<ds-range>` for seek, volume, and stereo balance.
 */
@Component({
  tag: 'mp-transport',
  styleUrl: 'mp-transport.scss',
})
export class MpTransport {
  @Prop() playerTarget!: string;
  @Prop() status: PlaybackStatus = 'stopped';
  @Prop() track: Track | null = null;
  @Prop() trackIndex = -1;
  @Prop() trackCount = 0;
  @Prop() currentTime = 0;
  @Prop() duration = 0;
  @Prop() buffered = 0;
  @Prop() volume = 0.85;
  @Prop() muted = false;
  @Prop() balance = 0;
  @Prop() shuffle = false;
  @Prop() repeat: RepeatMode = 'off';
  @Prop() showRemaining = false;
  @Prop() compact = false;

  @Event() mpSeek!: EventEmitter<number>;
  @Event() mpVolumeChange!: EventEmitter<number>;
  @Event() mpBalanceChange!: EventEmitter<number>;

  @State() isScrubbing = false;
  @State() scrubValue = 0;

  private seekRangeEl?: RangeHostRef;
  private seekInputEl?: HTMLInputElement;
  private volumeRangeEl?: RangeHostRef;
  private volumeInputEl?: HTMLInputElement;
  private balanceRangeEl?: RangeHostRef;
  private balanceInputEl?: HTMLInputElement;

  private seekFormatter = ({ value, max }: { value: number; max: number }) => `${formatTime(value)} / ${formatTime(max)}`;
  private volumeFormatter = ({ value }: { value: number }) => `${Math.round(value)}%`;
  private balanceFormatter = ({ value }: { value: number }) => formatBalance(value / 100);

  componentDidRender() {
    this.syncRangeControls();
  }

  private syncRangeControls() {
    const displayedTime = this.isScrubbing ? this.scrubValue : this.currentTime;
    if (this.seekInputEl && !this.isScrubbing) {
      const nextVal = String(Math.min(displayedTime, this.duration || 0));
      if (this.seekInputEl.value !== nextVal) {
        this.seekInputEl.value = nextVal;
      }
      void this.seekRangeEl?.refresh?.();
    }

    if (this.volumeInputEl) {
      const volPct = String(Math.round((this.muted ? 0 : this.volume) * 100));
      if (this.volumeInputEl.value !== volPct) {
        this.volumeInputEl.value = volPct;
      }
      void this.volumeRangeEl?.refresh?.();
    }

    if (this.balanceInputEl) {
      const balPct = String(Math.round(this.balance * 100));
      if (this.balanceInputEl.value !== balPct) {
        this.balanceInputEl.value = balPct;
      }
      void this.balanceRangeEl?.refresh?.();
    }
  }

  private handleSeekInput = (event: Event) => {
    const val = Number((event.target as HTMLInputElement).value);
    this.isScrubbing = true;
    this.scrubValue = val;
  };

  private handleSeekCommit = (event: Event) => {
    const val = Number((event.target as HTMLInputElement).value);
    this.isScrubbing = false;
    this.mpSeek.emit(val);
  };

  private handleVolumeInput = (event: Event) => {
    const val = Number((event.target as HTMLInputElement).value);
    this.mpVolumeChange.emit(val / 100);
  };

  private handleBalanceInput = (event: Event) => {
    const val = Number((event.target as HTMLInputElement).value);
    // Subtle magnetic snap to center near 0.
    const snapped = Math.abs(val) <= 4 ? 0 : val;
    this.mpBalanceChange.emit(snapped / 100);
  };

  private getVolumeIcon(): string {
    if (this.muted || this.volume <= 0.001) {
      return 'volume-mute';
    }
    return this.volume < 0.5 ? 'volume-low' : 'volume-high';
  }

  private getRepeatLabel(): string {
    if (this.repeat === 'one') return 'Repeat: One (R)';
    if (this.repeat === 'all') return 'Repeat: All (R)';
    return 'Repeat: Off (R)';
  }

  render() {
    const isPlaying = this.status === 'playing';
    const hasTracks = this.trackCount > 0;
    const displayedTime = this.isScrubbing ? this.scrubValue : this.currentTime;
    const maxDuration = this.duration > 0 ? this.duration : 0;
    const primaryTime = formatTime(displayedTime, this.showRemaining, maxDuration);
    const totalTime = formatTime(maxDuration);

    return (
      <Host class={{ 'mp-transport': true, '--compact': this.compact }}>
        {/* Track Display & Time Readout */}
        <div class="mp-transport__display">
          <div class="mp-transport__meta">
            <div class="mp-transport__title-row">
              <span class={{ 'mp-status-dot': true, '--playing': isPlaying, '--paused': this.status === 'paused' }} aria-hidden="true" />
              <span class="mp-transport__title" title={this.track?.title || 'No track loaded'}>
                {this.track ? this.track.title : 'Drop audio files or click Open'}
              </span>
            </div>
            <div class="mp-transport__sub-row">
              <span class="mp-transport__artist">
                {this.track?.artist || (hasTracks ? 'Unknown artist' : 'MP3 · FLAC · WAV · OGG · OPUS · M4A')}
              </span>
              {this.track?.format && (
                <ds-badge class="mp-transport__format" type="neutral">
                  {this.track.format}
                </ds-badge>
              )}
              {hasTracks && (
                <span class="mp-transport__counter">
                  {String(this.trackIndex + 1).padStart(2, '0')} / {String(this.trackCount).padStart(2, '0')}
                </span>
              )}
            </div>
          </div>

          <ds-trigger
            mods="mp-clock"
            target={this.playerTarget}
            action="toggleTimeDisplay"
            label={this.showRemaining ? 'Showing remaining time. Click for elapsed time' : 'Showing elapsed time. Click for remaining time'}
          >
            <span class="mp-transport__time">{primaryTime}</span>
            <span class="mp-transport__duration">/ {totalTime}</span>
          </ds-trigger>
        </div>

        {/* Seek Progress Bar */}
        <div class="mp-transport__seek">
          <ds-range
            mods="seek"
            buffer={maxDuration > 0 ? this.buffered : undefined}
            formatter={this.seekFormatter}
            ref={el => (this.seekRangeEl = el as unknown as RangeHostRef)}
          >
            <input
              type="range"
              min="0"
              max={String(maxDuration || 100)}
              step="0.1"
              value={String(displayedTime)}
              disabled={!this.track || maxDuration <= 0}
              aria-label="Playback position"
              ref={el => (this.seekInputEl = el as HTMLInputElement)}
              onInput={this.handleSeekInput}
              onChange={this.handleSeekCommit}
            />
          </ds-range>
        </div>

        {/* Controls Row: Transport + Modes + Volume / Balance */}
        <div class="mp-transport__controls">
          <div class="mp-transport__buttons" role="group" aria-label="Playback controls">
            <ds-tooltip>
              <ds-trigger
                mods="mp-icon"
                target={this.playerTarget}
                action="previous"
                disabled={!hasTracks}
                label="Previous track (Z)"
              >
                <ds-icon type="skip-back" />
              </ds-trigger>
              <span slot="message">Previous (Z)</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger
                type="button"
                mods="stl-1,rounded,mp-play"
                target={this.playerTarget}
                action="togglePlay"
                label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              >
                <ds-icon type={isPlaying ? 'pause' : 'play'} />
              </ds-trigger>
              <span slot="message">{isPlaying ? 'Pause (Space)' : 'Play (Space)'}</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger
                mods="mp-icon"
                target={this.playerTarget}
                action="stop"
                disabled={this.status === 'stopped'}
                label="Stop (V)"
              >
                <ds-icon type="stop" />
              </ds-trigger>
              <span slot="message">Stop (V)</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger mods="mp-icon" target={this.playerTarget} action="next" disabled={!hasTracks} label="Next track (B)">
                <ds-icon type="skip-forward" />
              </ds-trigger>
              <span slot="message">Next (B)</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger mods="mp-icon" target={this.playerTarget} action="openFilePicker" label="Open audio files">
                <ds-icon type="eject" />
              </ds-trigger>
              <span slot="message">Open files</span>
            </ds-tooltip>
          </div>

          <div class="mp-transport__modes" role="group" aria-label="Playback modes">
            <ds-tooltip>
              <ds-trigger
                mods={this.shuffle ? 'mp-icon,active' : 'mp-icon'}
                target={this.playerTarget}
                action="toggleShuffle"
                label="Toggle shuffle (S)"
                aria-pressed={this.shuffle ? 'true' : 'false'}
              >
                <ds-icon type="shuffle" />
              </ds-trigger>
              <span slot="message">Shuffle (S)</span>
            </ds-tooltip>

            <ds-tooltip>
              <ds-trigger
                mods={this.repeat !== 'off' ? 'mp-icon,active' : 'mp-icon'}
                target={this.playerTarget}
                action="cycleRepeat"
                label={this.getRepeatLabel()}
                aria-pressed={this.repeat !== 'off' ? 'true' : 'false'}
              >
                <ds-icon type={this.repeat === 'one' ? 'repeat-one' : 'repeat'} />
              </ds-trigger>
              <span slot="message">{this.getRepeatLabel()}</span>
            </ds-tooltip>
          </div>

          <div class="mp-transport__mixers">
            <div class="mp-transport__volume">
              <ds-trigger
                mods={this.muted ? 'mp-icon,muted' : 'mp-icon'}
                target={this.playerTarget}
                action="toggleMute"
                label={this.muted ? 'Unmute (M)' : 'Mute (M)'}
                aria-pressed={this.muted ? 'true' : 'false'}
              >
                <ds-icon type={this.getVolumeIcon()} />
              </ds-trigger>
              <ds-range
                class="mp-transport__volume-range"
                mods="compact"
                formatter={this.volumeFormatter}
                ref={el => (this.volumeRangeEl = el as unknown as RangeHostRef)}
              >
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={String(Math.round((this.muted ? 0 : this.volume) * 100))}
                  aria-label="Volume"
                  ref={el => (this.volumeInputEl = el as HTMLInputElement)}
                  onInput={this.handleVolumeInput}
                />
              </ds-range>
            </div>

            {!this.compact && (
              <div class="mp-transport__balance">
                <ds-trigger
                  mods="mp-bal-label"
                  target={this.playerTarget}
                  action="setBalance:[0]"
                  label={`Stereo balance: ${formatBalance(this.balance)}. Click to center`}
                >
                  BAL
                </ds-trigger>
                <ds-range
                  class="mp-transport__balance-range"
                  mods="compact,center"
                  formatter={this.balanceFormatter}
                  ref={el => (this.balanceRangeEl = el as unknown as RangeHostRef)}
                >
                  <input
                    type="range"
                    min="-100"
                    max="100"
                    step="1"
                    value={String(Math.round(this.balance * 100))}
                    aria-label="Stereo balance"
                    ref={el => (this.balanceInputEl = el as HTMLInputElement)}
                    onInput={this.handleBalanceInput}
                  />
                </ds-range>
              </div>
            )}
          </div>
        </div>
      </Host>
    );
  }
}
