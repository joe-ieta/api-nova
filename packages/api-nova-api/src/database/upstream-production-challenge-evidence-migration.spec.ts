import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
jest.mock('../config/environment', () => ({}));
import { buildDatabaseOptions } from './database-options';
import { createUpstreamSecurityProofAuthority } from '../modules/publication/security/upstream-security-proof-authority';
const { acceptProductionEvidence } = require('../../scripts/production-challenge-evidence-acceptance.cjs');
describe('independent production-format challenge evidence storage', () => {
  it('migrates, rejects invalid observations, reopens, expires/revokes and never promotes prototype or DB rows to proof', async () => {
    const original = { ...process.env }, root = mkdtempSync(join(tmpdir(), 'apinova-production-evidence-'));
    try {
      process.env.DB_TYPE = 'sqlite'; process.env.DB_SQLITE_PATH = join(root, 'fixture.sqlite');
      const proof = createUpstreamSecurityProofAuthority({} as any, {} as any);
      const report = await acceptProductionEvidence(DataSource, buildDatabaseOptions(), async row => !(await proof.isCurrent(row, {} as any)));
      expect(report).toMatchObject({ migrations: 7, checks: true, reopen: true, expiry: true, revocation: true, prototypeIsolation: true, noProof: true, reversible: true, schemaDrift: 0 });
    } finally {
      process.env = original; const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('apinova-production-evidence-')) throw Error('Unsafe fixture cleanup');
      rmSync(target, { recursive: true, force: true });
    }
  });
});
