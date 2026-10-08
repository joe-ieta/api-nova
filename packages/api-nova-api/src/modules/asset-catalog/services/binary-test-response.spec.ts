import { Readable } from 'node:stream';
import { readBoundedTestResponse } from './binary-test-response';

describe('binary-declared HTTP response media classification', () => {
  it.each(['application/x-unknown-binary', ''])('does not decode unknown %s bytes into JSON sample text', async mediaType => {
    const capture = jest.fn();
    const result = await readBoundedTestResponse(
      Readable.from([Buffer.from([0, 255, 128, 1])], { objectMode: false }),
      { 'content-type': mediaType }, 1024, capture,
    );
    expect(result).toEqual({
      captureState: 'unavailable', reason: 'untrusted_media_type', mediaType,
      observedBytes: 4, isComplete: true,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('\\u0000');
  });

  it.each(['application/json', 'application/problem+json'])('preserves decoded %s objects', async mediaType => {
    const result = await readBoundedTestResponse(
      Readable.from([Buffer.from('{"ok":true}')], { objectMode: false }),
      { 'content-type': mediaType }, 1024,
    );
    expect(result).toEqual({ ok: true });
  });

  it.each(['text/plain', 'text/html', 'application/xml', 'image/svg+xml'])('preserves decoded %s text without creating a binary object', async mediaType => {
    const capture = jest.fn();
    const result = await readBoundedTestResponse(
      Readable.from([Buffer.from('known text')], { objectMode: false }),
      { 'content-type': mediaType }, 1024, capture,
    );
    expect(result).toBe('known text');
    expect(capture).not.toHaveBeenCalled();
  });
});
