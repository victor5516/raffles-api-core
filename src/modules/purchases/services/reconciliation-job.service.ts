import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ReconciliationJob,
  ReconciliationJobStatus,
} from '../entities/reconciliation-job.entity';
import { ReconciliationResult } from '../dto/reconciliation.dto';
import {
  RECONCILIATION_EVENTS,
  ReconciliationProcessEvent,
} from '../events/reconciliation.events';
import { ReconciliationJobResponseDto } from '../dto/reconciliation-job.dto';
import { Purchase } from '../entities/purchase.entity';

@Injectable()
export class ReconciliationJobService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationJobService.name);

  constructor(
    @InjectRepository(ReconciliationJob)
    private readonly jobRepo: Repository<ReconciliationJob>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    const stale = await this.markStaleJobsFailed(15);
    if (stale > 0) {
      this.logger.warn(
        `[ReconciliationJob] ${stale} job(s) colgados marcados como FAILED al iniciar`,
      );
    }
  }

  /**
   * Guarda el job en DB y emite el evento para que el listener
   * procese en background. Retorna el job inmediatamente (status=PROCESSING).
   *
   * emit() llama el @OnEvent handler y obtiene una Promise,
   * pero NO la awaita — el handler corre en background (fire-and-forget).
   * Mismo comportamiento que PurchasesService con 'purchase.created'.
   */
  async enqueue(params: {
    fileBuffer: Buffer;
    fileMimeType: string;
    fileName: string | null;
    paymentMethodId: string;
    raffleId: string;
    createdBy: string | null;
  }): Promise<ReconciliationJob> {
    const job = this.jobRepo.create({
      raffleId: params.raffleId,
      paymentMethodId: params.paymentMethodId,
      fileName: params.fileName,
      fileMimeType: params.fileMimeType,
      status: ReconciliationJobStatus.PROCESSING,
      createdBy: params.createdBy,
      startedAt: new Date(),
    });

    const saved = await this.jobRepo.save(job);

    const payload: ReconciliationProcessEvent = {
      jobId: saved.uid,
      fileBuffer: params.fileBuffer,
      fileMimeType: params.fileMimeType,
      paymentMethodId: params.paymentMethodId,
      raffleId: params.raffleId,
    };
    this.eventEmitter.emit(RECONCILIATION_EVENTS.PROCESS, payload);

    this.logger.log(`[ReconciliationJob] Job ${saved.uid} encolado`);
    return saved;
  }

  async markComplete(
    jobId: string,
    result: ReconciliationResult,
  ): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: ReconciliationJobStatus.READY,
      result,
      completedAt: new Date(),
    });
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: ReconciliationJobStatus.FAILED,
      errorMessage,
      completedAt: new Date(),
    });
  }

  async findOne(uid: string): Promise<ReconciliationJob> {
    const job = await this.jobRepo.findOne({
      where: { uid },
      relations: ['raffle'],
    });
    if (!job) {
      throw new NotFoundException(`Job de conciliación ${uid} no encontrado`);
    }
    return job;
  }

  async getJobDetail(uid: string): Promise<ReconciliationJobResponseDto> {
    const job = await this.findOne(uid);

    const base: ReconciliationJobResponseDto = {
      uid: job.uid,
      raffleId: job.raffleId,
      paymentMethodId: job.paymentMethodId,
      fileName: job.fileName,
      status: job.status,
      result: null,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };

    if (!job.result) {
      return base;
    }

    const result = job.result;

    // Para jobs antiguos sin snapshot, enriquecer desde DB
    const legacyMatches = (result.matched ?? []).filter(
      (m) => !m.purchaseSnapshot,
    );
    let purchaseById: Record<string, Purchase> = {};
    if (legacyMatches.length > 0) {
      const ids = Array.from(
        new Set(
          legacyMatches
            .map((m) => m.purchaseId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      if (ids.length > 0) {
        const purchases = await this.jobRepo.manager.find(Purchase, {
          where: { uid: In(ids) },
          relations: ['customer'],
        });
        purchaseById = purchases.reduce<Record<string, Purchase>>((acc, p) => {
          acc[p.uid] = p;
          return acc;
        }, {});
      }
    }

    const mappedMatched = (result.matched ?? []).map((m) => {
      if (m.purchaseSnapshot && m.bankTransaction) {
        return {
          purchase: {
            uid: m.purchaseSnapshot.uid,
            customer: { name: m.purchaseSnapshot.customerName },
            totalAmount: m.purchaseSnapshot.totalAmount,
          },
          bankTransaction: {
            date: m.bankTransaction.date,
            amount: m.bankTransaction.amount,
            reference: m.bankTransaction.reference,
            description: m.bankTransaction.description,
          },
        };
      }

      const purchase = m.purchaseId ? purchaseById[m.purchaseId] : undefined;
      const customerName = purchase?.customer?.fullName ?? '';
      const totalAmount = Number(
        purchase?.totalPaid ?? purchase?.totalAmount ?? m.amount,
      );

      return {
        purchase: {
          uid: m.purchaseId,
          customer: { name: customerName },
          totalAmount,
        },
        bankTransaction: {
          date: '',
          amount: m.amount,
          reference: m.bankRef,
          description: '',
        },
      };
    });

    base.result = {
      matched: mappedMatched,
      unmatchedBank: result.unmatchedBank,
      unmatchedDb: result.unmatchedDb.map((p) => ({
        uid: p.uid,
        customerId: p.customerId,
        totalAmount: Number(p.totalPaid ?? p.totalAmount ?? 0),
        status: p.status,
      })),
      metadata: {
        totalBank: result.metadata.totalBank,
        totalDb: result.metadata.totalDb,
        range: {
          start: result.metadata.range.start,
          end: result.metadata.range.end,
        },
      },
    } as any;

    return base;
  }

  async findAll(params: {
    raffleId?: string;
    paymentMethodId?: string;
    limit?: number;
  }): Promise<ReconciliationJob[]> {
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.raffle', 'raffle')
      .orderBy('job.createdAt', 'DESC')
      .take(params.limit ?? 20);

    if (params.raffleId) {
      qb.andWhere('job.raffle_id = :raffleId', { raffleId: params.raffleId });
    }
    if (params.paymentMethodId) {
      qb.andWhere('job.payment_method_id = :pmId', {
        pmId: params.paymentMethodId,
      });
    }

    return qb.getMany();
  }

  private async markStaleJobsFailed(staleMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReconciliationJob)
      .set({
        status: ReconciliationJobStatus.FAILED,
        errorMessage: `Marcado automáticamente: sin completar en ${staleMinutes} minutos`,
        completedAt: new Date(),
      })
      .where('status = :status', { status: ReconciliationJobStatus.PROCESSING })
      .andWhere('started_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
