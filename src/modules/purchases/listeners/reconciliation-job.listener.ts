import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ReconciliationService } from '../services/reconciliation.service';
import { ReconciliationJobService } from '../services/reconciliation-job.service';
import {
  RECONCILIATION_EVENTS,
  ReconciliationProcessEvent,
} from '../events/reconciliation.events';

@Injectable()
export class ReconciliationJobListener {
  private readonly logger = new Logger(ReconciliationJobListener.name);

  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly jobService: ReconciliationJobService,
  ) {}

  @OnEvent(RECONCILIATION_EVENTS.PROCESS)
  async handleReconciliationProcess(
    event: ReconciliationProcessEvent,
  ): Promise<void> {
    const { jobId, fileBuffer, fileMimeType, paymentMethodId, raffleId } =
      event;

    this.logger.log(
      `[ReconciliationJobListener] Procesando job ${jobId} ` +
        `(raffleId=${raffleId}, paymentMethodId=${paymentMethodId})`,
    );

    try {
      const result = await this.reconciliationService.reconcile(
        fileBuffer,
        fileMimeType,
        paymentMethodId,
        raffleId,
      );

      await this.jobService.markComplete(jobId, result);

      this.logger.log(
        `[ReconciliationJobListener] Job ${jobId} completado: ` +
          `${result.matched.length} matches, ` +
          `${result.unmatchedBank.length} sin match bancario`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';

      await this.jobService.markFailed(jobId, message);

      this.logger.error(
        `[ReconciliationJobListener] Job ${jobId} falló: ${message}`,
      );
    }
  }
}
