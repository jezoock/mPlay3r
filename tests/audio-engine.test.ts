import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioEngine, dbToLinearGain } from '../src/core/audio-engine';
import { EQ_FREQUENCIES } from '../src/core/constants';

function createMockAudioParam(initial = 0) {
  return {
    value: initial,
    setTargetAtTime(val: number) {
      this.value = val;
    },
  };
}

function createMockAudioEnvironment() {
  const listeners = new Map<string, Array<() => void>>();
  const audioEl = {
    src: '',
    preload: '',
    crossOrigin: null as string | null,
    currentTime: 0,
    duration: 200,
    volume: 1,
    muted: false,
    buffered: { length: 1, end: () => 120 },
    error: null as { code: number } | null,
    removeAttribute() {
      this.crossOrigin = null;
    },
    load() {
      // mock load
    },
    async play() {
      listeners.get('playing')?.forEach(fn => fn());
    },
    pause() {
      listeners.get('pause')?.forEach(fn => fn());
    },
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    emit(type: string) {
      listeners.get(type)?.forEach(fn => fn());
    },
  };

  const gains: Array<{ gain: ReturnType<typeof createMockAudioParam>; connect: () => void }> = [];
  const filters: Array<{
    type: string;
    frequency: ReturnType<typeof createMockAudioParam>;
    Q: ReturnType<typeof createMockAudioParam>;
    gain: ReturnType<typeof createMockAudioParam>;
    connect: () => void;
  }> = [];
  const panner = { pan: createMockAudioParam(0), connect: () => undefined };
  const analyser = { fftSize: 0, smoothingTimeConstant: 0, connect: () => undefined };

  const audioContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    async resume() {
      this.state = 'running';
    },
    async close() {
      this.state = 'closed';
    },
    createMediaElementSource() {
      return { connect: () => undefined };
    },
    createGain() {
      const node = { gain: createMockAudioParam(1), connect: () => undefined };
      gains.push(node);
      return node;
    },
    createBiquadFilter() {
      const node = {
        type: '',
        frequency: createMockAudioParam(0),
        Q: createMockAudioParam(1),
        gain: createMockAudioParam(0),
        connect: () => undefined,
      };
      filters.push(node);
      return node;
    },
    createStereoPanner() {
      return panner;
    },
    createAnalyser() {
      return analyser;
    },
  };

  return { audioEl, audioContext, gains, filters, panner, analyser };
}

describe('AudioEngine Web Audio DSP graph', () => {
  it('builds 10-band Winamp EQ + preamp + panner + master gain + analyser lazily on play', async () => {
    const env = createMockAudioEnvironment();
    const statuses: string[] = [];
    const engine = new AudioEngine(
      { onStatusChange: s => statuses.push(s) },
      {
        createAudioElement: () => env.audioEl as unknown as HTMLAudioElement,
        createAudioContext: () => env.audioContext as unknown as AudioContext,
      },
    );

    assert.equal(engine.getAnalyserNode(), null);
    await engine.play('blob:song');

    assert.equal(engine.getStatus(), 'playing');
    assert.equal(env.filters.length, EQ_FREQUENCIES.length);
    assert.deepEqual(
      env.filters.map(f => f.frequency.value),
      [...EQ_FREQUENCIES],
    );
    assert.ok(engine.getAnalyserNode() !== null);
    assert.ok(statuses.includes('playing'));
  });

  it('applies EQ presets, manual band changes, bypass, volume, mute, and balance', async () => {
    const env = createMockAudioEnvironment();
    const engine = new AudioEngine(
      {},
      {
        createAudioElement: () => env.audioEl as unknown as HTMLAudioElement,
        createAudioContext: () => env.audioContext as unknown as AudioContext,
      },
    );

    await engine.play('blob:song');
    const [preampNode, masterGainNode] = env.gains;

    engine.applyEqPreset('rock');
    assert.equal(engine.getEqualizerState().preset, 'rock');
    assert.equal(env.filters[0].gain.value, 4.8);
    assert.equal(env.filters[3].gain.value, -4.8);

    engine.setPreamp(6);
    assert.ok(Math.abs(preampNode.gain.value - dbToLinearGain(6)) < 1e-6);

    // Bypass EQ cleanly flattens preamp and all 10 bands without losing saved values.
    engine.setEqualizerEnabled(false);
    assert.equal(preampNode.gain.value, 1);
    assert.ok(env.filters.every(f => f.gain.value === 0));
    assert.equal(engine.getEqualizerState().bands[0], 4.8);

    // Re-enable restores saved gains.
    engine.setEqualizerEnabled(true);
    assert.equal(env.filters[0].gain.value, 4.8);

    // Volume, mute, and stereo balance.
    engine.setVolume(0.5);
    assert.equal(masterGainNode.gain.value, 0.5);
    engine.toggleMute();
    assert.equal(masterGainNode.gain.value, 0);
    engine.toggleMute();
    assert.equal(masterGainNode.gain.value, 0.5);

    engine.setBalance(-0.75);
    assert.equal(env.panner.pan.value, -0.75);

    engine.resetEqualizer();
    assert.equal(engine.getEqualizerState().preset, 'flat');
    assert.ok(env.filters.every(f => f.gain.value === 0));

    // Seek clamping within duration [0..200].
    assert.equal(engine.seek(999), 200);
    assert.equal(engine.seek(-10), 0);
    assert.equal(engine.seek(42.5), 42.5);

    // Destroy cleans up AudioContext & analyser reference.
    engine.destroy();
    assert.equal(engine.getStatus(), 'stopped');
    assert.equal(engine.getAnalyserNode(), null);
    assert.equal(engine.getAudioContext(), null);
  });

  it('falls back cleanly to HTMLAudioElement when Web Audio API throws and surfaces media errors', async () => {
    const env = createMockAudioEnvironment();
    const errors: string[] = [];
    const engine = new AudioEngine(
      { onError: msg => errors.push(msg) },
      {
        createAudioElement: () => env.audioEl as unknown as HTMLAudioElement,
        createAudioContext: () => {
          throw new Error('AudioContext unavailable');
        },
      },
    );

    await engine.play('https://example.com/demo.mp3');
    assert.equal(env.audioEl.crossOrigin, 'anonymous');
    assert.equal(engine.getStatus(), 'playing');

    engine.setVolume(0.4);
    assert.equal(env.audioEl.volume, 0.4);
    engine.setMuted(true);
    assert.equal(env.audioEl.muted, true);

    env.audioEl.error = { code: 4 };
    env.audioEl.emit('error');
    assert.equal(engine.getStatus(), 'error');
    assert.equal(errors[0], 'Audio format or source is not supported.');
  });
});
