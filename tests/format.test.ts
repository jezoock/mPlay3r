import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clamp, formatBalance, formatDb, formatTime, formatTotalDuration, getFileExtension, isAudioFilename, isPlaylistFilename } from '../src/core/format';

describe('format utilities', () => {
  it('formats elapsed and remaining times cleanly', () => {
    assert.equal(formatTime(0), '00:00');
    assert.equal(formatTime(65), '01:05');
    assert.equal(formatTime(3661), '1:01:01');
    assert.equal(formatTime(undefined), '00:00');
    assert.equal(formatTime(Number.NaN), '00:00');
    assert.equal(formatTime(45, true, 180), '-02:15');
    assert.equal(formatTime(185, true, 180), '-00:00');
  });

  it('sums total playlist duration ignoring unknown durations', () => {
    assert.equal(formatTotalDuration([]), '00:00');
    assert.equal(formatTotalDuration([undefined, Number.NaN]), '00:00');
    assert.equal(formatTotalDuration([120, undefined, 95]), '03:35');
  });

  it('formats decibels and stereo balance', () => {
    assert.equal(formatDb(0), '0.0 dB');
    assert.equal(formatDb(4.5), '+4.5 dB');
    assert.equal(formatDb(-6), '-6.0 dB');
    assert.equal(formatBalance(0), 'Center');
    assert.equal(formatBalance(0.01), 'Center');
    assert.equal(formatBalance(-0.5), 'L 50%');
    assert.equal(formatBalance(1), 'R 100%');
  });

  it('clamps values safely and detects extensions', () => {
    assert.equal(clamp(15, -12, 12), 12);
    assert.equal(clamp(-20, -12, 12), -12);
    assert.equal(clamp(Number.NaN, 0, 1), 0);

    assert.equal(getFileExtension('/music/track.FLAC?v=1'), 'flac');
    assert.equal(getFileExtension('noext'), '');
    assert.equal(isAudioFilename('song.mp3'), true);
    assert.equal(isAudioFilename('song.opus'), true);
    assert.equal(isAudioFilename('notes.txt'), false);
    assert.equal(isPlaylistFilename('mix.m3u8'), true);
    assert.equal(isPlaylistFilename('winamp.pls'), true);
  });
});
