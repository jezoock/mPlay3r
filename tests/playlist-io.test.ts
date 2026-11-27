import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseM3u, parsePlaylistContent, parsePls, serializeM3u } from '../src/core/playlist-io';
import type { Track } from '../src/core/types';

describe('playlist M3U / PLS I/O', () => {
  it('parses extended M3U8 playlists with #EXTINF metadata', () => {
    const m3u = `#EXTM3U
#EXTINF:215,Boards of Canada - Dayvan Cowboy
https://cdn.example.com/audio/dayvan.mp3
#EXTINF:180,Solo Track
tracks/solo.ogg
`;
    const parsed = parseM3u(m3u, 'https://example.com/playlists/mix.m3u8');
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].artist, 'Boards of Canada');
    assert.equal(parsed[0].title, 'Dayvan Cowboy');
    assert.equal(parsed[0].duration, 215);
    assert.equal(parsed[0].src, 'https://cdn.example.com/audio/dayvan.mp3');

    assert.equal(parsed[1].title, 'Solo Track');
    assert.equal(parsed[1].src, 'https://example.com/playlists/tracks/solo.ogg');
    assert.equal(parsed[1].format, 'OGG');
  });

  it('parses classic Winamp PLS playlists in numeric order', () => {
    const pls = `[playlist]
File2=/music/second.flac
Title2=Massive Attack - Teardrop
Length2=329
File1=/music/first.mp3
Title1=Portishead - Roads
Length1=305
NumberOfEntries=2
Version=2
`;
    const parsed = parsePls(pls);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].artist, 'Portishead');
    assert.equal(parsed[0].title, 'Roads');
    assert.equal(parsed[0].duration, 305);
    assert.equal(parsed[0].filePath, '/music/first.mp3');
    assert.equal(parsed[1].artist, 'Massive Attack');
    assert.equal(parsed[1].title, 'Teardrop');
    assert.equal(parsed[1].format, 'FLAC');
  });

  it('auto-detects playlist format and round-trips M3U8 serialization', () => {
    const tracks: Track[] = [
      { id: '1', src: 'mplay3r://localhost/a.mp3', filePath: '/music/a.mp3', title: 'Track A', artist: 'Artist A', duration: 123.4 },
      { id: '2', src: 'https://example.com/b.ogg', title: 'Track B' },
    ];
    const m3u = serializeM3u(tracks);
    assert.ok(m3u.startsWith('#EXTM3U\n'));
    assert.ok(m3u.includes('#EXTINF:123,Artist A - Track A\n/music/a.mp3'));
    assert.ok(m3u.includes('#EXTINF:-1,Track B\nhttps://example.com/b.ogg'));

    const reparsed = parsePlaylistContent(m3u, 'saved.m3u8');
    assert.equal(reparsed.length, 2);
    assert.equal(reparsed[0].artist, 'Artist A');
    assert.equal(reparsed[0].title, 'Track A');
    assert.equal(reparsed[0].duration, 123);
    assert.equal(reparsed[1].title, 'Track B');
  });
});
