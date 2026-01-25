import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { AdminRole } from '../enums/admin-role.enum';

@Entity('admin')
export class Admin {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'full_name' })
  fullName: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: AdminRole,
    default: AdminRole.VERIFIER,
  })
  role: AdminRole;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
