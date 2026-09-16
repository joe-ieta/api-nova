import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Independent staging tombstone: deliberately no cascading sample foreign key. */
@Entity('endpoint_test_sample_objects')
@Index('IDX_sample_object_owner', ['sampleId', 'side'], { unique: true })
@Index('IDX_sample_object_key', ['objectKey'], { unique: true })
export class EndpointTestSampleObjectEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) sampleId: string;
  @Column({ type: 'varchar', length: 8, default: 'response' }) side: 'response';
  @Column({ type: 'varchar', length: 64 }) objectKey: string;
  @Column({ type: 'varchar', length: 16, default: 'staged' }) state: 'staged' | 'ready' | 'delete_pending' | 'deleted';
  @Column({ type: 'varchar', length: 128 }) mediaType: string;
  @Column({ type: 'varchar', length: 32 }) measurement: 'decoded_response_body' | 'encoded_response_body';
  @Column({ type: 'int' }) observedBytes: number;
  @Column({ type: 'varchar', length: 64 }) sha256: string;
  @Column({ type: 'int', default: 0 }) deleteAttempts: number;
  @Column({ type: 'varchar', length: 32, nullable: true }) failureCode?: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
