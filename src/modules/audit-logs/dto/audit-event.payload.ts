import { AuditAction } from '../entities/audit-log.entity';

export class AuditEventPayload {
  adminId: string | null;
  action: AuditAction;
  entityName: string;
  entityId: string;
  previousData: Record<string, any> | null;
  newData: Record<string, any> | null;
}
