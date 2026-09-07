import { GatewayRequestCaptureService } from './gateway-request-capture.service';

describe('GatewayRequestCaptureService', () => {
  const service = new GatewayRequestCaptureService();

  it('captures preview and hash for json payloads with truncation', () => {
    const tracker = service.createTracker('application/json');
    tracker.observeChunk(Buffer.from('{"message":"'));
    tracker.observeChunk(Buffer.from('x'.repeat(5000)));
    tracker.observeChunk(Buffer.from('"}'));

    const result = tracker.finalize();

    expect(result.totalBytes).toBeGreaterThan(4096);
    expect(result.preview).toContain('{"message":"');
    expect(result.preview).toContain('[truncated]');
    expect(result.truncated).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not preview binary payloads but still returns size and hash', () => {
    const tracker = service.createTracker('application/octet-stream');
    tracker.observeChunk(Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const result = tracker.finalize();

    expect(result.totalBytes).toBe(4);
    expect(result.preview).toBeUndefined();
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts multipart body content into a placeholder preview', () => {
    const tracker = service.createTracker('multipart/form-data; boundary=test');
    tracker.observeChunk(Buffer.from('--test\r\ncontent-disposition: form-data;\r\n\r\nabc\r\n'));

    const result = tracker.finalize();

    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.preview).toBe('[multipart/form-data omitted]');
  });
});
