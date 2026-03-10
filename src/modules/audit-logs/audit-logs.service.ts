import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditLog } from './entities/audit-log.entity';
import { AuditEventPayload } from './dto/audit-event.payload';

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  @OnEvent('audit.log', { async: true })
  async handleAuditLogEvent(payload: AuditEventPayload): Promise<void> {
    if (
      payload.action === 'UPDATE' &&
      JSON.stringify(payload.previousData) === JSON.stringify(payload.newData)
    ) {
      return;
    }

    const log = this.auditLogRepository.create(payload);
    await this.auditLogRepository.save(log);
  }
}
