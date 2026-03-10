import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  adminId: string | null;

  @Column({ type: 'varchar' })
  action: AuditAction;

  @Column({ type: 'varchar' })
  entityName: string;

  @Column({ type: 'varchar' })
  entityId: string;

  @Column({ type: 'jsonb', nullable: true })
  previousData: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  newData: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}
