import { Normalizer } from './normalizer';

describe('catalog server preservation', () => {
  const spec = (servers?: any[]) => ({
    openapi: '3.0.3', info: { title: 'Test', version: '1' }, paths: {}, servers,
  });
  it.each([{ servers: undefined }, { servers: [] }])('preserves missing and empty servers with catalog policy: %j', async ({ servers }) => {
    const result = await new Normalizer({ preserveMissingServers: true }).normalize(spec(servers));
    expect(result.servers).toEqual(servers);
  });
  it('keeps compatibility fallback for existing parser clients', async () => {
    const result = await new Normalizer({}).normalize(spec());
    expect(result.servers?.[0].url).toBe('http://localhost');
  });
  it.each(['http://localhost', '/api', 'https://example.test'])('retains explicit server %s', async url => {
    const result = await new Normalizer({ preserveMissingServers: true }).normalize(spec([{ url }]));
    expect(result.servers).toEqual([{ url }]);
  });
});
