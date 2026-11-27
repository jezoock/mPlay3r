import type { EqualizerPreset, EqualizerState, PaletteDefinition, PaletteId } from './types';

/** Classic 10-band Winamp equalizer center frequencies (Hz). */
export const EQ_FREQUENCIES: readonly number[] = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

/** Short display labels matching EQ_FREQUENCIES. */
export const EQ_BAND_LABELS: readonly string[] = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K'];

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_FILTER_Q = 1.41;

export const DEFAULT_EQUALIZER_STATE: EqualizerState = {
  enabled: true,
  preamp: 0,
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  preset: 'flat',
};

/** Classic Winamp-inspired equalizer presets (10 bands in dB). */
export const EQ_PRESETS: readonly EqualizerPreset[] = [
  { id: 'flat', name: 'Flat', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'rock', name: 'Rock', preamp: 0, bands: [4.8, 2.8, -3.4, -4.8, -2.0, 2.4, 5.4, 6.8, 6.8, 6.8] },
  { id: 'pop', name: 'Pop', preamp: 0, bands: [-1.0, 2.8, 4.4, 4.8, 3.2, -0.6, -1.4, -1.4, -1.0, -1.0] },
  { id: 'classical', name: 'Classical', preamp: 0, bands: [0, 0, 0, 0, 0, 0, -4.4, -4.4, -4.4, -5.8] },
  { id: 'jazz', name: 'Jazz', preamp: 0, bands: [3.2, 2.2, 0.8, 1.8, -1.6, -1.6, 0, 1.4, 2.8, 3.6] },
  { id: 'electronic', name: 'Electronic', preamp: 0, bands: [4.6, 3.8, 1.2, 0, -2.0, 2.0, 0.8, 1.4, 4.0, 4.8] },
  { id: 'club', name: 'Club', preamp: 0, bands: [0, 0, 4.8, 3.4, 3.4, 3.4, 2.0, 0, 0, 0] },
  { id: 'bass-boost', name: 'Full Bass', preamp: -1.5, bands: [6.0, 6.0, 6.0, 3.6, 1.0, -2.4, -5.0, -6.2, -6.6, -6.6] },
  { id: 'treble-boost', name: 'Full Treble', preamp: -1.5, bands: [-6.0, -6.0, -6.0, -2.4, 1.8, 6.4, 9.2, 9.2, 9.2, 9.6] },
  { id: 'full-bass-treble', name: 'Full Bass & Treble', preamp: -1.0, bands: [4.4, 3.4, 0, -4.4, -2.8, 1.0, 5.0, 6.6, 7.2, 7.2] },
  { id: 'vocal', name: 'Vocal', preamp: 0, bands: [-2.0, -3.0, -2.4, 1.4, 3.8, 4.2, 3.0, 1.2, -0.8, -1.6] },
  { id: 'acoustic', name: 'Acoustic', preamp: 0, bands: [3.6, 3.0, 1.8, 0.8, 1.6, 1.4, 2.4, 3.0, 2.6, 1.6] },
  { id: 'headphones', name: 'Headphones', preamp: 0, bands: [2.8, 6.4, 3.2, -2.0, -1.4, 1.0, 2.8, 5.6, 7.4, 8.4] },
  { id: 'soft', name: 'Soft', preamp: 0, bands: [2.8, 1.0, -0.6, -1.4, -0.6, 2.4, 5.0, 5.8, 6.6, 7.2] },
];

/** Minimalist theme color palettes (implemented via dot-stash scoped CSS tokens). */
export const PALETTES: readonly PaletteDefinition[] = [
  { id: 'obsidian', name: 'Obsidian', swatch: '#0e1116', accent: '#38bdf8', dark: true },
  { id: 'slate', name: 'Slate', swatch: '#f8fafc', accent: '#2563eb', dark: false },
  { id: 'amber', name: 'Amber', swatch: '#141210', accent: '#f59e0b', dark: true },
  { id: 'emerald', name: 'Emerald', swatch: '#0b1411', accent: '#10b981', dark: true },
  { id: 'sand', name: 'Sand', swatch: '#f4f1ea', accent: '#ea580c', dark: false },
];

export const DEFAULT_PALETTE: PaletteId = 'obsidian';

export const SUPPORTED_AUDIO_EXTENSIONS: readonly string[] = ['mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm'];

export const SUPPORTED_PLAYLIST_EXTENSIONS: readonly string[] = ['m3u', 'm3u8', 'pls'];

export const AUDIO_FILE_ACCEPT = [
  'audio/*',
  ...SUPPORTED_AUDIO_EXTENSIONS.map(ext => `.${ext}`),
  ...SUPPORTED_PLAYLIST_EXTENSIONS.map(ext => `.${ext}`),
].join(',');

export const PLAYLIST_FILE_ACCEPT = SUPPORTED_PLAYLIST_EXTENSIONS.map(ext => `.${ext}`).join(',');

export const STORAGE_KEY = 'mplay3r:state:v1';

export function isValidPalette(value: string | undefined | null): value is PaletteId {
  return PALETTES.some(palette => palette.id === value);
}

export function findEqPreset(id: string): EqualizerPreset | undefined {
  return EQ_PRESETS.find(preset => preset.id === id);
}
