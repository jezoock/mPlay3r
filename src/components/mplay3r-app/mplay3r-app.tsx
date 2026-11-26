import { Component, Element, h, Host, Method, State } from '@stencil/core';

/**
 * PR #1 root application scaffold verifying StencilJS light-DOM integration with dot-stash `ds-trigger`.
 * Full playback, playlist, equalizer, and theming are added incrementally in PR #2 - PR #6.
 */
@Component({
  tag: 'mplay3r-app',
  styleUrl: 'mplay3r-app.scss',
})
export class MPlay3rApp {
  @Element() host!: HTMLElement;

  @State() readyClicks = 0;

  private playerId = 'mplay3r';

  componentWillLoad() {
    if (!this.host.id) {
      this.host.id = 'mplay3r';
    }
    this.playerId = this.host.id;
  }

  @Method()
  async ping(): Promise<number> {
    this.readyClicks += 1;
    return this.readyClicks;
  }

  render() {
    return (
      <Host class="mp-app">
        <div class="mp-app__shell" role="region" aria-label="mPlay3r audio player">
          <span>mPlay3r scaffold ready</span>
          <ds-trigger type="button" mods="sm,stl-1" target={`#${this.playerId}`} action="ping">
            Check ds-trigger ({this.readyClicks})
          </ds-trigger>
        </div>
      </Host>
    );
  }
}
