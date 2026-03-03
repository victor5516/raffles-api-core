export const RECONCILIATION_EVENTS = {
  PROCESS: 'reconciliation.process',
  COMPLETED: 'reconciliation.completed',
  FAILED: 'reconciliation.failed',
} as const;

/** Payload emitido por ReconciliationJobService.enqueue() */
export interface ReconciliationProcessEvent {
  jobId: string;
  fileBuffer: Buffer;
  fileMimeType: string;
  paymentMethodId: string;
  raffleId: string;
}
