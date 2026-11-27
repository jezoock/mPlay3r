import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFilenameMetadata, parseId3TagsFromBuffer } from '../src/core/metadata';

function buildId3v23(frames: Array<{ id: string; text: string; encoding?: number }>): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const frame of frames) {
    const encoding = frame.encoding ?? 3; // UTF-8
    const textBytes = encoder.encode(frame.text);
    const frameBody = new Uint8Array(1 + textBytes.length);
    frameBody[0] = encoding;
    frameBody.set(textBytes, 1);

    const header = new Uint8Array(10);
    for (let i = 0; i < 4; i += 1) header[i] = frame.id.charCodeAt(i);
    const size = frameBody.length;
    header[4] = (size >>> 24) & 0xff;
    header[5] = (size >>> 16) & 0xff;
    header[6] = (size >>> 8) & 0xff;
    header[7] = size & 0xff;

    chunks.push(header, frameBody);
  }

  const bodyLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(10 + bodyLen);
  out[0] = 0x49; // I
  out[1] = 0x44; // D
  out[2] = 0x33; // 3
  out[3] = 3; // v2.3
  out[4] = 0;
  out[5] = 0;
  out[6] = (bodyLen >>> 21) & 0x7f;
  out[7] = (bodyLen >>> 14) & 0x7f;
  out[8] = (bodyLen >>> 7) & 0x7f;
  out[9] = bodyLen & 0x7f;

  let offset = 10;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

describe('local metadata parser (offline, zero scraping)', () => {
  it('parses track number, artist, title, and format from filenames', () => {
    assert.deepEqual(parseFilenameMetadata('/music/01 - Daft Punk - Aerodynamic.flac'), {
      artist: 'Daft Punk',
      title: 'Aerodynamic',
      format: 'FLAC',
    });

    assert.deepEqual(parseFilenameMetadata('04.boards_of_canada_-_roygbiv.mp3'), {
      artist: 'boards of canada',
      title: 'roygbiv',
      format: 'MP3',
    });

    assert.deepEqual(parseFilenameMetadata('ambient_loop.wav'), {
      title: 'ambient loop',
      format: 'WAV',
    });
  });

  it('reads local ID3v2.3 TIT2, TPE1, and TALB frames', () => {
    const buffer = buildId3v23([
      { id: 'TIT2', text: 'Around the World' },
      { id: 'TPE1', text: 'Daft Punk' },
      { id: 'TALB', text: 'Homework' },
    ]);

    assert.deepEqual(parseId3TagsFromBuffer(buffer), {
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
    });
  });

  it('reads ID3v1 fallback tags cleanly', () => {
    const raw = new Uint8Array(128);
    const write = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i += 1) raw[offset + i] = value.charCodeAt(i);
    };
    write(0, 'TAG');
    write(3, 'Windowlicker');
    write(33, 'Aphex Twin');
    write(63, 'Single');

    assert.deepEqual(parseId3TagsFromBuffer(raw.buffer), {
      title: 'Windowlicker',
      artist: 'Aphex Twin',
      album: 'Single',
    });
  });

  it('returns empty object on non-ID3 binary data without throwing', () => {
    const noise = new Uint8Array([0x00, 0xff, 0x10, 0x20]).buffer;
    assert.deepEqual(parseId3TagsFromBuffer(noise), {});
  });
});
