import { Component, Event, EventEmitter, h, Host, Prop, State } from '@stencil/core';
import type { PluginHost } from '../../plugins/host';
import { DEFAULT_PLUGIN_REGISTRY_URL, filterStoreCatalog, formatByteSize } from '../../plugins/registry';
import type { StoreCatalogItem } from '../../plugins/registry';
import { PluginStore } from '../../plugins/store';
import type { InstalledPluginRecord, PluginCategory, PluginDisposer } from '../../plugins/types';

const STORE_CATEGORIES: Array<{ id: PluginCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'source', label: 'Sources' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'visualizer', label: 'Visualizers' },
  { id: 'scraper', label: 'Scrapers' },
  { id: 'dsp', label: 'DSP' },
  { id: 'theme', label: 'Themes' },
];

/**
 * Integrated Phase 2 Plugin Store built with dot-stash (`ds-badge`, `ds-icon`, `ds-toggle`, `ds-trigger`).
 * Lazy-loaded only when the user opens the Store panel (0 KB on initial player load).
 */
@Component({
  tag: 'mp-store',
  styleUrl: 'mp-store.scss',
})
export class MpStore {
  @Prop() playerTarget!: string;
  @Prop() pluginHost?: PluginHost;
  @Prop() store?: PluginStore;
  @Prop() registries?: string[];
  @Prop() coreVersion = '0.1.0';

  @Event() mpStoreNotify!: EventEmitter<{ message: string; variant?: '' | 'success' | 'warning' | 'error' }>;

  @State() category: PluginCategory | 'all' = 'all';
  @State() searchQuery = '';
  @State() catalogItems: StoreCatalogItem[] = [];
  @State() installedPlugins: InstalledPluginRecord[] = [];
  @State() registryUrls: string[] = [];
  @State() newRegistryUrl = '';
  @State() showRegistries = false;
  @State() expandedId = '';
  @State() loading = false;
  @State() busyPluginId = '';
  @State() statusError = '';

  private activeStore!: PluginStore;
  private unsubscribeHost?: PluginDisposer;
  private localFileInputEl?: HTMLInputElement;

  async componentWillLoad() {
    this.activeStore =
      this.store ??
      new PluginStore({
        coreVersion: this.coreVersion,
        initialRegistries: this.registries,
      });

    if (this.pluginHost) {
      this.installedPlugins = this.pluginHost.getPlugins();
      this.unsubscribeHost = this.pluginHost.subscribe(() => {
        this.installedPlugins = this.pluginHost?.getPlugins() ?? [];
        this.catalogItems = this.activeStore.buildCatalogItems(this.installedPlugins);
      });
    }

    this.registryUrls = await this.activeStore.getRegistryUrls();
    await this.refresh();
  }

  disconnectedCallback() {
    this.unsubscribeHost?.();
  }

  private refresh = async () => {
    this.loading = true;
    this.statusError = '';
    try {
      const result = await this.activeStore.refreshCatalog(this.installedPlugins);
      this.catalogItems = result.items;
      if (result.errors.length > 0 && result.items.length === 0) {
        this.statusError = result.errors.map(e => `${e.url}: ${e.message}`).join(' · ');
      }
    } catch (error) {
      this.statusError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  };

  private handleInstall = async (item: StoreCatalogItem) => {
    if (!this.pluginHost || this.busyPluginId) {
      return;
    }
    this.busyPluginId = item.manifest.id;
    try {
      const record = await this.activeStore.installFromCatalog(item, this.pluginHost);
      if (record.status === 'error') {
        this.mpStoreNotify.emit({
          message: `Installed "${item.manifest.name}" with activation error: ${record.lastError || 'unknown error'}`,
          variant: 'warning',
        });
      } else {
        this.mpStoreNotify.emit({
          message: item.updateAvailable
            ? `Updated "${item.manifest.name}" to v${item.manifest.version}`
            : `Installed "${item.manifest.name}" (SHA-256 verified)`,
          variant: 'success',
        });
      }
    } catch (error) {
      this.mpStoreNotify.emit({
        message: error instanceof Error ? error.message : 'Failed to install plugin.',
        variant: 'error',
      });
    } finally {
      this.busyPluginId = '';
    }
  };

  private handleToggleEnabled = async (pluginId: string, enabled: boolean) => {
    if (!this.pluginHost) {
      return;
    }
    try {
      if (enabled) {
        const rec = await this.pluginHost.enable(pluginId);
        if (rec.status === 'error') {
          this.mpStoreNotify.emit({ message: rec.lastError || 'Plugin activation failed.', variant: 'error' });
        }
      } else {
        await this.pluginHost.disable(pluginId);
      }
    } catch (error) {
      this.mpStoreNotify.emit({ message: error instanceof Error ? error.message : 'Toggle failed.', variant: 'error' });
    }
  };

  private handleUninstall = async (pluginId: string, name: string) => {
    if (!this.pluginHost) {
      return;
    }
    await this.pluginHost.uninstall(pluginId);
    this.mpStoreNotify.emit({ message: `Removed "${name}"`, variant: '' });
  };

  private handleLocalImportChange = async (event: globalThis.Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.pluginHost) {
      return;
    }
    this.busyPluginId = '__local__';
    try {
      const record = await this.activeStore.installFromLocalFile(file, this.pluginHost);
      this.mpStoreNotify.emit({
        message: `Imported "${record.manifest.name}" v${record.manifest.version}`,
        variant: record.status === 'error' ? 'warning' : 'success',
      });
    } catch (error) {
      this.mpStoreNotify.emit({
        message: error instanceof Error ? error.message : 'Local plugin import failed.',
        variant: 'error',
      });
    } finally {
      input.value = '';
      this.busyPluginId = '';
    }
  };

  private handleAddRegistry = async (event: globalThis.Event) => {
    event.preventDefault();
    if (!this.newRegistryUrl.trim()) {
      return;
    }
    try {
      this.registryUrls = await this.activeStore.addRegistryUrl(this.newRegistryUrl);
      this.newRegistryUrl = '';
      await this.refresh();
      this.mpStoreNotify.emit({ message: 'Registry added', variant: 'success' });
    } catch (error) {
      this.mpStoreNotify.emit({
        message: error instanceof Error ? error.message : 'Invalid registry URL.',
        variant: 'error',
      });
    }
  };

  private handleRemoveRegistry = async (url: string) => {
    this.registryUrls = await this.activeStore.removeRegistryUrl(url);
    await this.refresh();
  };

  render() {
    const filtered = filterStoreCatalog(this.catalogItems, {
      category: this.category,
      query: this.searchQuery,
    });
    const catalogIds = new Set(this.catalogItems.map(item => item.manifest.id));
    const localOnly = this.installedPlugins.filter(rec => !catalogIds.has(rec.manifest.id));

    return (
      <Host class="mp-store" role="region" aria-label="Plugin Store">
        <input
          class="ds-visually-hidden"
          type="file"
          accept=".zip,.js,.mjs"
          tabindex="-1"
          aria-hidden="true"
          ref={el => (this.localFileInputEl = el as HTMLInputElement)}
          onChange={this.handleLocalImportChange}
        />

        <div class="mp-store__toolbar">
          <div class="mp-store__heading-group">
            <span class="mp-store__heading">Plugin Store</span>
            <ds-badge type="neutral" count={this.installedPlugins.length} />
          </div>

          <div class="mp-store__actions">
            <button
              type="button"
              class="mp-store__btn"
              disabled={Boolean(this.busyPluginId)}
              onClick={() => this.localFileInputEl?.click()}
            >
              <ds-icon type="upload" />
              <span>Import .zip</span>
            </button>

            <button
              type="button"
              class={{ 'mp-store__btn': true, '--active': this.showRegistries }}
              onClick={() => (this.showRegistries = !this.showRegistries)}
            >
              <ds-icon type="plus" />
              <span>Registries</span>
            </button>

            <button type="button" class="mp-store__btn" disabled={this.loading} onClick={this.refresh}>
              <span>{this.loading ? 'Sync…' : 'Refresh'}</span>
            </button>

            <ds-trigger mods="mp-icon" target={this.playerTarget} action="toggleStore" label="Close store">
              <ds-icon type="cancel" />
            </ds-trigger>
          </div>
        </div>

        {this.showRegistries && (
          <div class="mp-store__registries">
            <ul class="mp-store__registry-list">
              {this.registryUrls.map(url => (
                <li class="mp-store__registry-item" key={url}>
                  <span class="mp-store__registry-url" title={url}>
                    {url === DEFAULT_PLUGIN_REGISTRY_URL ? 'Official (mPlay3r-addons)' : url}
                  </span>
                  {url !== DEFAULT_PLUGIN_REGISTRY_URL && (
                    <button
                      type="button"
                      class="mp-store__icon-btn"
                      aria-label={`Remove registry ${url}`}
                      onClick={() => void this.handleRemoveRegistry(url)}
                    >
                      <ds-icon type="delete" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form class="mp-store__registry-form" onSubmit={this.handleAddRegistry}>
              <input
                class="mp-store__input"
                type="url"
                placeholder="https://example.com/registry.json"
                value={this.newRegistryUrl}
                aria-label="Add third-party plugin registry URL"
                onInput={event => (this.newRegistryUrl = (event.target as HTMLInputElement).value)}
              />
              <button type="submit" class="mp-store__btn --primary">
                Add
              </button>
            </form>
          </div>
        )}

        <div class="mp-store__filters">
          <div class="mp-store__categories" role="tablist" aria-label="Plugin categories">
            {STORE_CATEGORIES.map(cat => (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={this.category === cat.id ? 'true' : 'false'}
                class={{ 'mp-store__chip': true, '--active': this.category === cat.id }}
                onClick={() => (this.category = cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div class="mp-store__search">
            <ds-icon class="mp-store__search-icon" type="search" />
            <input
              class="mp-store__input --search"
              type="search"
              placeholder="Search plugins, permissions, authors…"
              value={this.searchQuery}
              aria-label="Search plugins"
              onInput={event => (this.searchQuery = (event.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="mp-store__list">
          {localOnly.map(rec => (
            <article class="mp-store__card" key={`local:${rec.manifest.id}`}>
              <div class="mp-store__card-head">
                <div class="mp-store__card-title-row">
                  <span class="mp-store__card-title">{rec.manifest.name}</span>
                  <ds-badge type="neutral">v{rec.manifest.version}</ds-badge>
                  <ds-badge type="info">Local</ds-badge>
                </div>
                <div class="mp-store__card-controls">
                  <ds-toggle
                    type="switch"
                    checked={rec.status === 'active'}
                    label={`Enable ${rec.manifest.name}`}
                    onToggle={(event: globalThis.Event) => {
                      const detail = (event as CustomEvent<{ checked?: boolean }>).detail;
                      void this.handleToggleEnabled(rec.manifest.id, Boolean(detail?.checked));
                    }}
                  />
                  <button
                    type="button"
                    class="mp-store__icon-btn"
                    aria-label={`Uninstall ${rec.manifest.name}`}
                    onClick={() => void this.handleUninstall(rec.manifest.id, rec.manifest.name)}
                  >
                    <ds-icon type="delete" />
                  </button>
                </div>
              </div>
              <p class="mp-store__card-desc">{rec.manifest.description}</p>
            </article>
          ))}

          {this.statusError && filtered.length === 0 ? (
            <p class="mp-store__empty">Unable to reach registry ({this.statusError}). You can still import a local .zip plugin.</p>
          ) : filtered.length === 0 && localOnly.length === 0 ? (
            <p class="mp-store__empty">{this.loading ? 'Loading verified catalog…' : 'No matching plugins found.'}</p>
          ) : (
            filtered.map(item => {
              const { manifest } = item;
              const isInstalled = item.status !== 'available';
              const isBusy = this.busyPluginId === manifest.id;
              const isExpanded = this.expandedId === manifest.id;

              return (
                <article class="mp-store__card" key={manifest.id}>
                  <div class="mp-store__card-head">
                    <div class="mp-store__card-title-row">
                      <span class="mp-store__card-title">{manifest.name}</span>
                      <ds-badge type="neutral">v{manifest.version}</ds-badge>
                      <ds-badge type="neutral">{manifest.category}</ds-badge>
                      <span class="mp-store__size">{formatByteSize(manifest.sizeBytes)}</span>
                    </div>

                    <div class="mp-store__card-controls">
                      {!isInstalled ? (
                        <button
                          type="button"
                          class="mp-store__btn --primary"
                          disabled={!item.compatible || isBusy}
                          onClick={() => void this.handleInstall(item)}
                        >
                          <ds-icon type="download" />
                          <span>{isBusy ? 'Verifying…' : 'Install'}</span>
                        </button>
                      ) : (
                        [
                          item.updateAvailable && (
                            <button
                              key="update"
                              type="button"
                              class="mp-store__btn --primary"
                              disabled={!item.compatible || isBusy}
                              onClick={() => void this.handleInstall(item)}
                            >
                              <span>{isBusy ? 'Updating…' : `Update v${manifest.version}`}</span>
                            </button>
                          ),
                          <ds-toggle
                            key="toggle"
                            type="switch"
                            checked={item.status === 'active'}
                            label={`Enable ${manifest.name}`}
                            onToggle={(event: globalThis.Event) => {
                              const detail = (event as CustomEvent<{ checked?: boolean }>).detail;
                              void this.handleToggleEnabled(manifest.id, Boolean(detail?.checked));
                            }}
                          />,
                          <button
                            key="remove"
                            type="button"
                            class="mp-store__icon-btn"
                            aria-label={`Uninstall ${manifest.name}`}
                            onClick={() => void this.handleUninstall(manifest.id, manifest.name)}
                          >
                            <ds-icon type="delete" />
                          </button>,
                        ]
                      )}
                    </div>
                  </div>

                  <p class="mp-store__card-desc">{manifest.description}</p>

                  <div class="mp-store__card-meta">
                    {!item.compatible && (
                      <ds-badge type="warning">Requires mPlay3r ≥ {manifest.minCoreVersion}</ds-badge>
                    )}
                    <button
                      type="button"
                      class="mp-store__details-btn"
                      aria-expanded={isExpanded ? 'true' : 'false'}
                      onClick={() => (this.expandedId = isExpanded ? '' : manifest.id)}
                    >
                      {isExpanded ? 'Hide details' : `Permissions (${manifest.permissions.length})`}
                    </button>
                  </div>

                  {isExpanded && (
                    <div class="mp-store__details">
                      <div class="mp-store__perms">
                        {manifest.permissions.length === 0 ? (
                          <ds-badge type="success">Zero permissions required</ds-badge>
                        ) : (
                          manifest.permissions.map(perm => (
                            <ds-badge key={perm} type="info">
                              {perm}
                            </ds-badge>
                          ))
                        )}
                      </div>
                      <div class="mp-store__fingerprint">
                        <span>ID: {manifest.id}</span>
                        {manifest.author && <span> · By {manifest.author}</span>}
                        {manifest.sha256 && <span> · SHA-256: {manifest.sha256.slice(0, 12)}…</span>}
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </Host>
    );
  }
}
