import { DEFAULT_EQUALIZER_STATE, EQ_FILTER_Q, EQ_FREQUENCIES, EQ_MAX_DB, EQ_MIN_DB, findEqPreset } from './constants';
import { clamp } from './format';
import type { EqualizerState, PlaybackStatus } from './types';

export interface AudioEngineCallbacks {
  onStatusChange?: (status: PlaybackStatus) => void;
  onTimeUpdate?: (time: { currentTime: number; duration: number; buffered: number }) => void;
  onDurationChange?: (duration: number) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
}

export interface AudioEngineDeps {
  createAudioElement?: () => HTMLAudioElement;
  createAudioContext?: () => AudioContext;
}

/** Converts gain in decibels to linear Web Audio gain multiplier. */
export function dbToLinearGain(db: number): number {
  return Math.pow(10, clamp(db, EQ_MIN_DB, EQ_MAX_DB) / 20);
}

/**
 * Zero-dependency Web Audio API engine:
 *   HTMLAudioElement -> MediaElementSource -> Preamp (GainNode)
 *   -> 10x Peaking BiquadFilterNode (Winamp 60Hz..16kHz)
 *   -> StereoPannerNode (Balance) -> Master GainNode -> AnalyserNode -> Destination
 *
 * AudioContext is initialized lazily on user playback so idle CPU/RAM stay minimal.
 * Exposes `getAnalyserNode()` and `getAudioContext()` as clean Phase 2 hooks for visualizer & DSP plugins.
 */
export class AudioEngine {
  private audio: HTMLAudioElement;
  private createAudioContext: () => AudioContext;
  private callbacks: AudioEngineCallbacks;

  private audioContext: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private preampNode: GainNode | null = null;
  private eqNodes: BiquadFilterNode[] = [];
  private pannerNode: StereoPannerNode | null = null;
  private masterGainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private status: PlaybackStatus = 'stopped';
  private volume = 0.85;
  private muted = false;
  private balance = 0;
  private equalizer: EqualizerState = {
    ...DEFAULT_EQUALIZER_STATE,
    bands: [...DEFAULT_EQUALIZER_STATE.bands],
  };

  private currentSrc = '';
  private webAudioConnected = false;

  constructor(callbacks: AudioEngineCallbacks = {}, deps: AudioEngineDeps = {}) {
    this.callbacks = callbacks;
    this.createAudioContext =
      deps.createAudioContext ??
      (() => {
        const Ctor =
          window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          throw new Error('Web Audio API is not supported in this environment.');
        }
        return new Ctor();
      });

    this.audio = deps.createAudioElement ? deps.createAudioElement() : new Audio();
    this.audio.preload = 'metadata';
    this.bindAudioEvents();
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }

  getVolume(): number {
    return this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  getBalance(): number {
    return this.balance;
  }

  getEqualizerState(): EqualizerState {
    return {
      enabled: this.equalizer.enabled,
      preamp: this.equalizer.preamp,
      bands: [...this.equalizer.bands],
      preset: this.equalizer.preset,
    };
  }

  getCurrentTime(): number {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  getDuration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  getBuffered(): number {
    try {
      if (this.audio.buffered && this.audio.buffered.length > 0) {
        return this.audio.buffered.end(this.audio.buffered.length - 1);
      }
    } catch {
      // Ignore buffered read errors in mock environments.
    }
    return 0;
  }

  /** Phase 2 extension hook: returns the live AnalyserNode for visualizer plugins once audio is initialized. */
  getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode;
  }

  /** Phase 2 extension hook: returns the AudioContext for AudioWorklet / DSP plugins. */
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  loadSource(src: string): void {
    this.currentSrc = src;
    // Request CORS headers for cross-origin streams so Web Audio EQ/Analyser remain active.
    if (/^https?:/i.test(src)) {
      this.audio.crossOrigin = 'anonymous';
    } else {
      this.audio.removeAttribute?.('crossorigin');
    }
    this.audio.src = src;
    this.audio.load();
    this.setStatus('loading');
  }

  async play(src?: string): Promise<void> {
    if (src && src !== this.currentSrc) {
      this.loadSource(src);
    }
    if (!this.currentSrc) {
      return;
    }

    this.ensureWebAudioGraph();
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch {
        // Browser may still play via HTMLAudioElement even if resume rejects.
      }
    }

    try {
      await this.audio.play();
      this.setStatus('playing');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start audio playback.';
      this.setStatus('error');
      this.callbacks.onError?.(message);
    }
  }

  pause(): void {
    this.audio.pause();
    if (this.status === 'playing' || this.status === 'loading') {
      this.setStatus('paused');
    }
  }

  stop(): void {
    this.audio.pause();
    try {
      this.audio.currentTime = 0;
    } catch {
      // Ignore if no media is loaded yet.
    }
    this.setStatus('stopped');
    this.callbacks.onTimeUpdate?.({ currentTime: 0, duration: this.getDuration(), buffered: this.getBuffered() });
  }

  seek(seconds: number): number {
    const duration = this.getDuration();
    const target = duration > 0 ? clamp(seconds, 0, duration) : Math.max(0, seconds);
    try {
      this.audio.currentTime = target;
    } catch {
      // Ignore seek when source has not loaded metadata yet.
    }
    this.callbacks.onTimeUpdate?.({ currentTime: target, duration, buffered: this.getBuffered() });
    return target;
  }

  setVolume(volume: number): number {
    this.volume = clamp(volume, 0, 1);
    if (this.volume > 0 && this.muted) {
      this.muted = false;
    }
    this.applyGainAndPan();
    return this.volume;
  }

  setMuted(muted: boolean): boolean {
    this.muted = Boolean(muted);
    this.applyGainAndPan();
    return this.muted;
  }

  toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  setBalance(balance: number): number {
    this.balance = clamp(balance, -1, 1);
    this.applyGainAndPan();
    return this.balance;
  }

  setEqualizerEnabled(enabled: boolean): EqualizerState {
    this.equalizer.enabled = Boolean(enabled);
    this.applyEqualizer();
    return this.getEqualizerState();
  }

  setPreamp(db: number): EqualizerState {
    this.equalizer.preamp = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
    this.equalizer.preset = this.detectMatchingPreset();
    this.applyEqualizer();
    return this.getEqualizerState();
  }

  setEqBand(index: number, db: number): EqualizerState {
    if (index >= 0 && index < EQ_FREQUENCIES.length) {
      this.equalizer.bands[index] = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
      this.equalizer.preset = this.detectMatchingPreset();
      this.applyEqualizer();
    }
    return this.getEqualizerState();
  }

  applyEqPreset(presetId: string): EqualizerState {
    const preset = findEqPreset(presetId);
    if (!preset) {
      return this.getEqualizerState();
    }
    this.equalizer.preamp = clamp(preset.preamp, EQ_MIN_DB, EQ_MAX_DB);
    this.equalizer.bands = preset.bands.map(val => clamp(val, EQ_MIN_DB, EQ_MAX_DB));
    this.equalizer.preset = preset.id;
    this.applyEqualizer();
    return this.getEqualizerState();
  }

  setEqualizerState(state: Partial<EqualizerState>): EqualizerState {
    if (typeof state.enabled === 'boolean') {
      this.equalizer.enabled = state.enabled;
    }
    if (typeof state.preamp === 'number') {
      this.equalizer.preamp = clamp(state.preamp, EQ_MIN_DB, EQ_MAX_DB);
    }
    if (Array.isArray(state.bands) && state.bands.length === EQ_FREQUENCIES.length) {
      this.equalizer.bands = state.bands.map(val => clamp(val, EQ_MIN_DB, EQ_MAX_DB));
    }
    this.equalizer.preset = state.preset || this.detectMatchingPreset();
    this.applyEqualizer();
    return this.getEqualizerState();
  }

  resetEqualizer(): EqualizerState {
    return this.applyEqPreset('flat');
  }

  destroy(): void {
    this.stop();
    this.audio.src = '';
    try {
      this.sourceNode?.disconnect();
      this.preampNode?.disconnect();
      this.eqNodes.forEach(node => node.disconnect());
      this.pannerNode?.disconnect();
      this.masterGainNode?.disconnect();
      this.analyserNode?.disconnect();
    } catch {
      // Ignore disconnect errors if nodes were already detached.
    }
    if (this.audioContext && typeof this.audioContext.close === 'function') {
      void this.audioContext.close();
    }
    this.audioContext = null;
    this.sourceNode = null;
    this.preampNode = null;
    this.eqNodes = [];
    this.pannerNode = null;
    this.masterGainNode = null;
    this.analyserNode = null;
    this.webAudioConnected = false;
  }

  private ensureWebAudioGraph(): void {
    if (this.webAudioConnected) {
      return;
    }
    try {
      const ctx = this.createAudioContext();
      const source = ctx.createMediaElementSource(this.audio);
      const preamp = ctx.createGain();
      const filters = EQ_FREQUENCIES.map(frequency => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = frequency;
        filter.Q.value = EQ_FILTER_Q;
        filter.gain.value = 0;
        return filter;
      });
      const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      const masterGain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;

      let tail: AudioNode = source;
      tail.connect(preamp);
      tail = preamp;
      for (const filter of filters) {
        tail.connect(filter);
        tail = filter;
      }
      if (panner) {
        tail.connect(panner);
        tail = panner;
      }
      tail.connect(masterGain);
      masterGain.connect(analyser);
      analyser.connect(ctx.destination);

      this.audioContext = ctx;
      this.sourceNode = source;
      this.preampNode = preamp;
      this.eqNodes = filters;
      this.pannerNode = panner;
      this.masterGainNode = masterGain;
      this.analyserNode = analyser;
      this.webAudioConnected = true;

      // Once routed through Web Audio, HTMLAudioElement volume stays at 1 so masterGainNode controls level smoothly.
      this.audio.volume = 1;
      this.audio.muted = false;
      this.applyEqualizer();
      this.applyGainAndPan();
    } catch {
      // Fallback: continue using HTMLAudioElement volume/mute directly.
      this.applyGainAndPan();
    }
  }

  private applyEqualizer(): void {
    if (!this.audioContext || !this.preampNode || this.eqNodes.length !== EQ_FREQUENCIES.length) {
      return;
    }
    const now = this.audioContext.currentTime;
    const preampLinear = this.equalizer.enabled ? dbToLinearGain(this.equalizer.preamp) : 1;
    setParamSmooth(this.preampNode.gain, preampLinear, now);

    for (let i = 0; i < this.eqNodes.length; i += 1) {
      const targetGain = this.equalizer.enabled ? this.equalizer.bands[i] : 0;
      setParamSmooth(this.eqNodes[i].gain, targetGain, now);
    }
  }

  private applyGainAndPan(): void {
    const effectiveGain = this.muted ? 0 : this.volume;
    if (this.webAudioConnected && this.audioContext && this.masterGainNode) {
      const now = this.audioContext.currentTime;
      setParamSmooth(this.masterGainNode.gain, effectiveGain, now);
      if (this.pannerNode) {
        setParamSmooth(this.pannerNode.pan, this.balance, now);
      }
    } else {
      this.audio.volume = effectiveGain;
      this.audio.muted = this.muted;
    }
  }

  private detectMatchingPreset(): string {
    const isFlat = Math.abs(this.equalizer.preamp) < 0.05 && this.equalizer.bands.every(v => Math.abs(v) < 0.05);
    return isFlat ? 'flat' : 'custom';
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.callbacks.onStatusChange?.(status);
    }
  }

  private bindAudioEvents(): void {
    this.audio.addEventListener('playing', () => this.setStatus('playing'));
    this.audio.addEventListener('pause', () => {
      if (this.status !== 'stopped' && this.status !== 'error') {
        this.setStatus('paused');
      }
    });
    this.audio.addEventListener('waiting', () => {
      if (this.status === 'playing') {
        this.setStatus('loading');
      }
    });
    this.audio.addEventListener('loadedmetadata', () => {
      const duration = this.getDuration();
      if (duration > 0) {
        this.callbacks.onDurationChange?.(duration);
      }
      this.callbacks.onTimeUpdate?.({ currentTime: this.getCurrentTime(), duration, buffered: this.getBuffered() });
    });
    this.audio.addEventListener('timeupdate', () => {
      this.callbacks.onTimeUpdate?.({
        currentTime: this.getCurrentTime(),
        duration: this.getDuration(),
        buffered: this.getBuffered(),
      });
    });
    this.audio.addEventListener('ended', () => {
      this.callbacks.onEnded?.();
    });
    this.audio.addEventListener('error', () => {
      const code = this.audio.error?.code;
      const messages: Record<number, string> = {
        1: 'Audio playback aborted.',
        2: 'Network error while loading audio.',
        3: 'Audio decoding failed.',
        4: 'Audio format or source is not supported.',
      };
      this.setStatus('error');
      this.callbacks.onError?.((code && messages[code]) || 'Unable to load audio source.');
    });
  }
}

function setParamSmooth(param: AudioParam, value: number, now: number): void {
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(value, now, 0.015);
  } else {
    param.value = value;
  }
}
