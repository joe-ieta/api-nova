import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
jest.mock('../config/environment', () => ({}));
import { buildDatabaseOptions } from './database-options';
import { UpstreamAuthenticationEvidenceEntity as Evidence } from './entities/upstream-authentication-evidence.entity';
describe('registered upstream challenge evidence storage',()=>{
 it('upgrades old SQLite schema, preserves rows, rejects trust promotion, persists and reverses without drift',async()=>{
  const original={...process.env},root=mkdtempSync(join(tmpdir(),'apinova-auth-migration-'));let db:DataSource;
  try {
   process.env.DB_TYPE='sqlite';process.env.DB_SQLITE_PATH=join(root,'fixture.sqlite');const full=buildDatabaseOptions();const options={...full,migrations:(full.migrations as string[]).filter(path=>!path.includes('GatewayHeaderHistoryLedger') && !path.includes('UpstreamProductionChallengeEvidence')),entities:(full.entities as Function[]).filter(entity=>entity.name!=='GatewayHeaderHistoryLedgerEntity' && entity.name!=='UpstreamProductionChallengeEvidenceEntity')};
   db=await new DataSource({...options,migrations:(options.migrations as string[]).slice(0,-1)} as any).initialize();
   expect(await db.runMigrations()).toHaveLength(4);
   await db.query(`INSERT INTO source_service_assets (id,sourceKey) VALUES ('legacy-source','legacy-source')`);await db.destroy();
   db=await new DataSource(options).initialize();expect(await db.runMigrations()).toHaveLength(1);
   const repo=db.getRepository(Evidence);expect(await repo.count()).toBe(0);
   const row=await repo.save({sourceServiceAssetId:'legacy-source',endpointDefinitionId:'endpoint',contextDigest:'a'.repeat(64),providerEpoch:'epoch',runNonce:'old-process',bindingRevision:'r1',bindingGeneration:1,actorId:'operator',result:'passed',anonymousBeforeStatus:401,wrongCredentialStatus:401,validCredentialStatus:200,anonymousAfterStatus:401});
   expect(row.evidenceKind).toBe('challenge_prototype');
   await expect(db.query(`UPDATE upstream_authentication_evidence SET result='Verified' WHERE id=?`,[row.id])).rejects.toThrow();
   await expect(db.query(`UPDATE upstream_authentication_evidence SET evidenceKind='production_verified' WHERE id=?`,[row.id])).rejects.toThrow();
   expect((await db.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);await db.destroy();
   db=await new DataSource(options).initialize();expect(await db.runMigrations()).toHaveLength(0);
   expect(await db.getRepository(Evidence).findOneByOrFail({id:row.id})).toMatchObject({runNonce:'old-process',result:'passed',evidenceKind:'challenge_prototype'});
   expect(await db.query(`SELECT sourceKey FROM source_service_assets WHERE id='legacy-source'`)).toEqual([{sourceKey:'legacy-source'}]);
   expect(db.getMetadata(Evidence).columns.map(c=>c.propertyName)).not.toEqual(expect.arrayContaining(['headers','secret','responseBody']));
   await db.undoLastMigration();expect(await db.runMigrations()).toHaveLength(1);expect(await db.getRepository(Evidence).count()).toBe(0);
   expect((await db.driver.createSchemaBuilder().log()).upQueries).toHaveLength(0);
  } finally {if(db?.isInitialized)await db.destroy();process.env=original;const target=resolve(root);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('apinova-auth-migration-'))throw new Error('Unsafe fixture cleanup');rmSync(target,{recursive:true,force:true});}
 });
});
