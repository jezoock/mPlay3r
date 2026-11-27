import { Component, h, Host, Prop } from '@stencil/core';
import { PALETTES } from '../../core';
import type { PaletteId } from '../../core';

/**
 * Minimalist header bar for mPlay3r.
 * Every control uses `<ds-trigger>` targeting the host `<mplay3r-app>` element.
 */
@Component({
  tag: 'mp-header',
  styleUrl: 'mp-header.scss',
})
export class MpHeader {
  @Prop() playerTarget!: string;
  @Prop() palette: PaletteId = 'obsidian';
  @Prop() showEqualizer = false;
  @Prop() showPlaylist = true;
  @Prop() compact = false;
  @Prop() isPortable = false;

  render() {
    return (
      <Host class="mp-header">
        <div class="mp-header__brand">
          <ds-icon class="mp-header__logo" type="music" />
          <span class="mp-header__title">mPlay3r</span>
          {this.isPortable && (
            <ds-badge class="mp-header__portable" type="info">
              Portable
            </ds-badge>
          )}
        </div>

        <div class="mp-header__palettes" role="group" aria-label="Color palette">
          {PALETTES.map(item => {
            const isActive = item.id === this.palette;
            return (
              <ds-trigger
                key={item.id}
                mods={isActive ? 'mp-swatch,active' : 'mp-swatch'}
                target={this.playerTarget}
                action={`setPalette:${JSON.stringify([item.id])}`}
                label={`Switch to ${item.name} color scheme`}
                aria-pressed={isActive ? 'true' : 'false'}
                style={{
                  '--mp-swatch-bg': item.swatch,
                  '--mp-swatch-accent': item.accent,
                }}
              />
            );
          })}
        </div>

        <div class="mp-header__toggles" role="group" aria-label="Panels">
          <ds-trigger
            mods={this.showEqualizer && !this.compact ? 'mp-pill,active' : 'mp-pill'}
            target={this.playerTarget}
            action="toggleEqualizer"
            label="Toggle equalizer"
            aria-pressed={this.showEqualizer && !this.compact ? 'true' : 'false'}
          >
            <ds-icon type="sliders" />
            <span>EQ</span>
          </ds-trigger>

          <ds-trigger
            mods={this.showPlaylist && !this.compact ? 'mp-pill,active' : 'mp-pill'}
            target={this.playerTarget}
            action="togglePlaylist"
            label="Toggle playlist"
            aria-pressed={this.showPlaylist && !this.compact ? 'true' : 'false'}
          >
            <ds-icon type="playlist" />
            <span>PL</span>
          </ds-trigger>

          <ds-trigger
            mods={this.compact ? 'mp-icon,active' : 'mp-icon'}
            target={this.playerTarget}
            action="toggleCompact"
            label={this.compact ? 'Expand player' : 'Compact mode'}
            aria-pressed={this.compact ? 'true' : 'false'}
          >
            <ds-icon type={this.compact ? 'arrow-down' : 'arrow-up'} />
          </ds-trigger>
        </div>
      </Host>
    );
  }
}
