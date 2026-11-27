import { Component, Event, EventEmitter, h, Host, Prop } from '@stencil/core';
import { DEFAULT_EQUALIZER_STATE, EQ_BAND_LABELS, EQ_MAX_DB, EQ_MIN_DB, EQ_PRESETS, formatDb } from '../../core';
import type { EqualizerState } from '../../core';

interface RangeHostRef extends HTMLElement {
  refresh?: () => Promise<void>;
}

/**
 * Classic 10-band Winamp graphic equalizer (60Hz .. 16kHz) + Preamp.
 * Uses dot-stash `ds-toggle`, `ds-select`, `ds-trigger`, and vertical `ds-range` faders.
 */
@Component({
  tag: 'mp-equalizer',
  styleUrl: 'mp-equalizer.scss',
})
export class MpEqualizer {
  @Prop() playerTarget!: string;
  @Prop() equalizer: EqualizerState = { ...DEFAULT_EQUALIZER_STATE, bands: [...DEFAULT_EQUALIZER_STATE.bands] };

  @Event() mpEqToggle!: EventEmitter<boolean>;
  @Event() mpPreampChange!: EventEmitter<number>;
  @Event() mpBandChange!: EventEmitter<{ index: number; gain: number }>;
  @Event() mpPresetChange!: EventEmitter<string>;

  private preampRangeEl?: RangeHostRef;
  private preampInputEl?: HTMLInputElement;
  private bandRangeEls: Array<RangeHostRef | undefined> = [];
  private bandInputEls: Array<HTMLInputElement | undefined> = [];
  private selectHostEl?: HTMLElement;
  private syncingSelect = false;

  private dbFormatter = ({ value }: { value: number }) => formatDb(value);

  componentDidRender() {
    this.syncFaders();
    this.syncPresetSelect();
  }

  private syncFaders() {
    if (this.preampInputEl) {
      const val = String(this.equalizer.preamp);
      if (this.preampInputEl.value !== val) {
        this.preampInputEl.value = val;
      }
      void this.preampRangeEl?.refresh?.();
    }

    this.equalizer.bands.forEach((gain, index) => {
      const input = this.bandInputEls[index];
      if (input) {
        const val = String(gain);
        if (input.value !== val) {
          input.value = val;
        }
        void this.bandRangeEls[index]?.refresh?.();
      }
    });
  }

  private syncPresetSelect() {
    const select = this.selectHostEl?.querySelector('select');
    if (!select) {
      return;
    }
    const targetVal = this.equalizer.preset || 'custom';
    if (select.value !== targetVal) {
      this.syncingSelect = true;
      select.value = targetVal;
      select.dispatchEvent(new window.Event('change', { bubbles: false }));
      this.syncingSelect = false;
    }
  }

  private handlePresetSelect = (event: CustomEvent<{ selectedOption?: HTMLOptionElement }>) => {
    if (this.syncingSelect) {
      return;
    }
    const value = event.detail?.selectedOption?.value;
    if (value && value !== 'custom') {
      this.mpPresetChange.emit(value);
    }
  };

  private buildCurvePath(): string {
    const width = 320;
    const height = 44;
    const padX = 12;
    const padY = 6;
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;
    const bands = this.equalizer.enabled ? this.equalizer.bands : this.equalizer.bands.map(() => 0);

    const points = bands.map((gain, idx) => {
      const x = padX + (usableW * idx) / (bands.length - 1);
      const norm = (gain - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB);
      const y = padY + (1 - norm) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(' ');
  }

  render() {
    const { enabled, preamp, bands, preset } = this.equalizer;

    return (
      <Host class={{ 'mp-equalizer': true, '--bypassed': !enabled }} role="region" aria-label="10-band equalizer">
        <div class="mp-equalizer__toolbar">
          <div class="mp-equalizer__switch">
            <ds-toggle
              type="switch"
              checked={enabled}
              label="Enable equalizer"
              onToggle={(event: Event) => {
                const detail = (event as CustomEvent<{ checked?: boolean }>).detail;
                this.mpEqToggle.emit(Boolean(detail?.checked));
              }}
            />
            <span class="mp-equalizer__heading">Equalizer</span>
          </div>

          <div class="mp-equalizer__actions">
            <ds-select
              class="mp-equalizer__preset"
              name="mp-eq-preset"
              label="Equalizer preset"
              ref={el => (this.selectHostEl = el as HTMLElement)}
              onValueChange={this.handlePresetSelect}
            >
              {EQ_PRESETS.map(item => (
                <option value={item.id} selected={preset === item.id}>
                  {item.name}
                </option>
              ))}
              <option value="custom" selected={preset === 'custom'}>
                Custom
              </option>
            </ds-select>

            <ds-trigger
              mods="mp-pill"
              target={this.playerTarget}
              action="resetEqualizer"
              label="Reset equalizer to flat"
            >
              Reset
            </ds-trigger>
          </div>
        </div>

        {/* Minimal live frequency curve */}
        <div class="mp-equalizer__curve" aria-hidden="true">
          <svg viewBox="0 0 320 44" preserveAspectRatio="none">
            <line class="mp-equalizer__zero-line" x1="8" y1="22" x2="312" y2="22" />
            <polyline class="mp-equalizer__curve-line" points={this.buildCurvePath()} />
          </svg>
        </div>

        {/* Preamp + 10 Winamp Bands */}
        <div class="mp-equalizer__grid">
          <div class="mp-equalizer__scale" aria-hidden="true">
            <span>+12</span>
            <span>0 dB</span>
            <span>-12</span>
          </div>

          {/* Preamp fader */}
          <div class="mp-equalizer__fader --preamp">
            <span class="mp-equalizer__value">{formatDb(preamp).replace(' dB', '')}</span>
            <div class="mp-equalizer__slider-wrap" onDblClick={() => this.mpPreampChange.emit(0)}>
              <ds-range
                mods="vertical"
                formatter={this.dbFormatter}
                ref={el => (this.preampRangeEl = el as unknown as RangeHostRef)}
              >
                <input
                  type="range"
                  min={String(EQ_MIN_DB)}
                  max={String(EQ_MAX_DB)}
                  step="0.5"
                  value={String(preamp)}
                  disabled={!enabled}
                  aria-label="Preamp gain"
                  ref={el => (this.preampInputEl = el as HTMLInputElement)}
                  onInput={event => this.mpPreampChange.emit(Number((event.target as HTMLInputElement).value))}
                />
              </ds-range>
            </div>
            <span class="mp-equalizer__band-label">PRE</span>
          </div>

          <div class="mp-equalizer__divider" aria-hidden="true" />

          {/* 10 Winamp frequency bands */}
          {EQ_BAND_LABELS.map((label, index) => (
            <div class="mp-equalizer__fader" key={label}>
              <span class="mp-equalizer__value">{formatDb(bands[index] ?? 0).replace(' dB', '')}</span>
              <div class="mp-equalizer__slider-wrap" onDblClick={() => this.mpBandChange.emit({ index, gain: 0 })}>
                <ds-range
                  mods="vertical"
                  formatter={this.dbFormatter}
                  ref={el => (this.bandRangeEls[index] = el as unknown as RangeHostRef)}
                >
                  <input
                    type="range"
                    min={String(EQ_MIN_DB)}
                    max={String(EQ_MAX_DB)}
                    step="0.5"
                    value={String(bands[index] ?? 0)}
                    disabled={!enabled}
                    aria-label={`${label} Hz equalizer band`}
                    ref={el => (this.bandInputEls[index] = el as HTMLInputElement)}
                    onInput={event =>
                      this.mpBandChange.emit({
                        index,
                        gain: Number((event.target as HTMLInputElement).value),
                      })
                    }
                  />
                </ds-range>
              </div>
              <span class="mp-equalizer__band-label">{label}</span>
            </div>
          ))}
        </div>
      </Host>
    );
  }
}
