import { describe, expect, it } from 'vitest';
import { formatBytes, isDefinitelyNotVideo, sniffVideoContainer } from '../video';

function bytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((character) => character.charCodeAt(0)));
}

function mp4(header = 'ftypisom'): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x00, 0x20, ...bytes(header)]);
}

describe('sniffVideoContainer', () => {
  it('recognises an ISO base media file from its ftyp box', () => {
    expect(sniffVideoContainer(mp4())).toBe('mp4');
  });

  it('recognises a fragmented MP4 that starts with styp', () => {
    expect(sniffVideoContainer(mp4('stypmsdh'))).toBe('mp4');
  });

  it('recognises WebM from the EBML signature', () => {
    expect(sniffVideoContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]))).toBe('webm');
  });

  it('recognises a JSON error document served with a video content type', () => {
    expect(sniffVideoContainer(bytes('{"error":"asset expired"}'))).toBe('json');
  });

  it('recognises an HTML error page', () => {
    expect(sniffVideoContainer(bytes('<!doctype html><html>'))).toBe('html');
  });

  it('recognises a zip archive', () => {
    expect(sniffVideoContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('zip');
  });

  it('reports unknown for bytes it cannot identify rather than guessing', () => {
    expect(sniffVideoContainer(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe('unknown');
    expect(sniffVideoContainer(new Uint8Array([]))).toBe('unknown');
  });
});

describe('isDefinitelyNotVideo', () => {
  it('never rejects a container the browser might still decode', () => {
    expect(isDefinitelyNotVideo('mp4')).toBe(false);
    expect(isDefinitelyNotVideo('webm')).toBe(false);
    expect(isDefinitelyNotVideo('unknown')).toBe(false);
  });

  it('rejects documents and archives that can never play', () => {
    expect(isDefinitelyNotVideo('json')).toBe(true);
    expect(isDefinitelyNotVideo('html')).toBe(true);
    expect(isDefinitelyNotVideo('zip')).toBe(true);
    expect(isDefinitelyNotVideo('png')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats each magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB');
  });
});
