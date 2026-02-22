import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, Brackets } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Purchase,
  PurchaseStatus,
  VerificationSource,
  PaymentEntry,
} from '../entities/purchase.entity';

export type PurchaseVerificationAction =
  | 'VERIFIED_NEW'
  | 'UPDATED'
  | 'MANUAL_REVIEW'
  | 'DUPLICATED'
  | 'ERROR';

export interface PurchaseVerificationResult {
  purchase: Purchase;
  action: PurchaseVerificationAction;
}

@Injectable()
export class PurchaseVerificationService {
  private readonly logger = new Logger(PurchaseVerificationService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Procesa el resultado de IA para una compra existente.
   * No maneja transacciones ni asignación de tickets.
   */
  async processAiWebhook(
    manager: EntityManager,
    purchaseId: string,
    aiResult: any,
  ): Promise<PurchaseVerificationResult> {
    this.logger.log(
      `[processAiWebhook] Inicio validación purchaseId=${purchaseId} hasAiResult=${Boolean(aiResult)}`,
    );

    const lockedPurchase = await manager.findOne(Purchase, {
      where: { uid: purchaseId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedPurchase) {
      this.logger.warn(
        `[processAiWebhook] Purchase no encontrado purchaseId=${purchaseId}`,
      );
      throw new NotFoundException('Purchase not found');
    }

    // Cargamos las relaciones en una consulta separada para evitar conflictos con FOR UPDATE.
    const purchase = await manager.findOne(Purchase, {
      where: { uid: purchaseId },
      relations: ['raffle', 'paymentMethod', 'paymentMethod.currency'],
    });
    if (!purchase) {
      this.logger.warn(
        `[processAiWebhook] Purchase no encontrado (relations) purchaseId=${purchaseId}`,
      );
      throw new NotFoundException('Purchase not found');
    }

    const wasVerified = purchase.status === PurchaseStatus.VERIFIED;

    // 1. Guardamos el resultado crudo para auditoría futura
    purchase.aiAnalysisResult = aiResult ?? null;

    // Webhooks duplicados/tardíos no deben degradar una compra ya verificada
    if (wasVerified) {
      this.logger.log(
        `[processAiWebhook] Compra ya verificada, solo guardando aiResult purchaseId=${purchaseId}`,
      );
      const saved = await manager.save(Purchase, purchase);
      return {
        purchase: saved,
        action: 'UPDATED',
      };
    }

    // Definimos la interfaz que coincide con el OCR Service actual
    interface AiAnalysisResponse {
      isValidReceipt?: boolean;
      isGenuineReceipt?: boolean | null;
      documentType?: string;
      fraudReason: string | null;
      confidence?: number;
      fraudIndicators?: string[] | null;
      amount?: number | null;
      reference?: string | null;
      data?: {
        amount?: number | null;
        reference?: string | null;
        currency?: string | null;
        date?: string | null;
      };
    }

    if (!aiResult || typeof aiResult !== 'object') {
      this.logger.warn(
        `[processAiWebhook] Payload inválido: sin objeto aiResult purchaseId=${purchaseId}`,
      );
      const saved = await this.handleManualReview(
        manager,
        purchase,
        'IA: Payload inválido (sin objeto aiResult)',
      );
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // Normalizamos para soportar payload nuevo (data.*) y legacy (campos flat)
    const aiData = aiResult as AiAnalysisResponse;
    const extractedAmount = aiData.data?.amount ?? aiData.amount ?? null;
    const extractedRef = aiData.data?.reference ?? aiData.reference ?? null;
    const aiIsValidReceipt =
      typeof aiData.isValidReceipt === 'boolean'
        ? aiData.isValidReceipt
        : aiData.isGenuineReceipt === true
          ? true
          : aiData.isGenuineReceipt === false
            ? false
            : undefined;
    const aiFraudReason =
      aiData.fraudReason ??
      (Array.isArray(aiData.fraudIndicators) &&
      aiData.fraudIndicators.length > 0
        ? aiData.fraudIndicators.join(' | ')
        : null);
    const aiDocumentType = aiData.documentType ?? 'UNKNOWN';

    // =================================================================
    // FASE 1: DETECCIÓN DE FRAUDE (Bloqueo Inmediato)
    // =================================================================

    // Si el OCR dice que NO es un recibo válido (ej: es un formulario o chat)
    if (aiIsValidReceipt === false) {
      const reason = `[FRAUDE DETECTADO] Documento inválido: ${aiFraudReason || 'No es un comprobante bancario final'} (${aiDocumentType})`;
      this.logger.warn(
        `[processAiWebhook] FASE 1 Fraude detectado purchaseId=${purchaseId} documentType=${aiDocumentType} reason=${aiFraudReason ?? 'N/A'}`,
      );
      const saved = await this.handleManualReview(manager, purchase, reason);
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // =================================================================
    // FASE 2: VALIDACIÓN DE DATOS BÁSICOS
    // =================================================================

    if (
      extractedAmount === null ||
      extractedAmount === undefined ||
      !extractedRef
    ) {
      this.logger.warn(
        `[processAiWebhook] FASE 2 Datos insuficientes purchaseId=${purchaseId} amount=${String(extractedAmount)} ref=${String(extractedRef)}`,
      );
      const saved = await this.handleManualReview(
        manager,
        purchase,
        'IA: Datos insuficientes (No se pudo leer monto o referencia)',
      );
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // =================================================================
    // FASE 3: CHEQUEO DE DUPLICADOS (Match Difuso)
    // =================================================================
    const normalizedAiRef = this.normalizeReference(extractedRef);

    if (!normalizedAiRef) {
      this.logger.warn(
        `[processAiWebhook] FASE 3 Referencia vacía tras normalización purchaseId=${purchaseId} extractedRef=${String(extractedRef)}`,
      );
      const saved = await this.handleManualReview(
        manager,
        purchase,
        'IA: Referencia vacía tras normalización',
      );
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // Buscamos si esta referencia YA EXISTE en otra compra (evitar doble canje)
    const existingWithRef = await manager
      .getRepository(Purchase)
      .createQueryBuilder('p')
      .where('p.uid != :uid', { uid: purchaseId }) // Excluir la compra actual
      .andWhere(
        new Brackets((qb) => {
          // A. Coincidencia en la referencia principal (Legacy)
          qb.where(
            "REGEXP_REPLACE(UPPER(p.bank_reference), '[^A-Z0-9]', '', 'g') = :ref",
            { ref: normalizedAiRef },
          )
            // B. Coincidencia en el resultado de IA previo
            .orWhere(
              "p.ai_analysis_result->'data'->>'reference' IS NOT NULL AND REGEXP_REPLACE(UPPER(p.ai_analysis_result->'data'->>'reference'), '[^A-Z0-9]', '', 'g') = :ref",
              { ref: normalizedAiRef },
            )
            // C. Coincidencia dentro del array de pagos (Abonos)
            .orWhere(
              `EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p.payments) AS elem
                  WHERE REGEXP_REPLACE(UPPER(elem->>'reference'), '[^A-Z0-9]', '', 'g') = :ref
                )`,
              { ref: normalizedAiRef },
            );
        }),
      )
      .getOne();

    if (existingWithRef) {
      this.logger.log(
        `[processAiWebhook] FASE 3 Referencia duplicada purchaseId=${purchaseId} duplicatePurchaseId=${existingWithRef.uid} normalizedRef=${normalizedAiRef}`,
      );
      purchase.status = PurchaseStatus.DUPLICATED;
      purchase.ticketNumbers = null;
      purchase.notes = `Referencia duplicada. Compra duplicada uid: ${existingWithRef.uid}`;
      purchase.exportedToSheets = false;
      const saved = await manager.save(Purchase, purchase);
      this.emitStatusChange(
        saved,
        'duplicated',
        `Referencia duplicada con compra ${existingWithRef.uid}`,
      );
      return {
        purchase: saved,
        action: 'DUPLICATED',
      };
    }

    // =================================================================
    // FASE 4: VINCULACIÓN CON EL PAGO (Abonos)
    // =================================================================

    const paymentsArray: PaymentEntry[] = purchase.payments ?? [];
    let matchedPaymentIndex = -1;

    // Buscamos a cuál de los pagos reportados por el usuario corresponde esta foto
    if (paymentsArray.length > 0) {
      for (let i = 0; i < paymentsArray.length; i++) {
        const entry = paymentsArray[i];
        if (entry.verified) continue; // Saltamos los que ya están listos

        const normalizedEntryRef = this.normalizeReference(entry.reference);
        // Usamos coincidencia difusa (ej: termina en...)
        if (
          normalizedEntryRef &&
          this.isReferenceMatch(normalizedEntryRef, normalizedAiRef)
        ) {
          matchedPaymentIndex = i;
          break;
        }
      }
    }

    // Si no encontramos match en el array, probamos con la referencia legacy
    const normalizedUserRef = this.normalizeReference(purchase.bankReference);
    const legacyRefMatch = normalizedUserRef
      ? this.isReferenceMatch(normalizedUserRef, normalizedAiRef)
      : false;

    if (matchedPaymentIndex === -1 && !legacyRefMatch) {
      this.logger.warn(
        `[processAiWebhook] FASE 4 Referencia no coincide purchaseId=${purchaseId} userRef=${normalizedUserRef ?? 'N/A'} photoRef=${normalizedAiRef}`,
      );
      const saved = await this.handleManualReview(
        manager,
        purchase,
        `IA: Referencia no coincide. Usuario dijo: "${normalizedUserRef || 'N/A'}", Foto dice: "${normalizedAiRef}"`,
      );
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // =================================================================
    // FASE 5: VALIDACIÓN DE MONTO
    // =================================================================
    let isAmountValid: boolean;
    let targetAmount = 0;

    if (matchedPaymentIndex >= 0) {
      // Validamos contra el abono específico
      targetAmount = Number(paymentsArray[matchedPaymentIndex].amount);
      isAmountValid = Math.abs(targetAmount - extractedAmount) < 1.0; // Tolerancia de 1.00 por decimales
    } else {
      // Legacy: Validamos contra el total
      targetAmount = Number(purchase.totalAmount);
      isAmountValid = Math.abs(targetAmount - extractedAmount) < 1.0;
    }

    if (!isAmountValid) {
      this.logger.warn(
        `[processAiWebhook] FASE 5 Monto incorrecto purchaseId=${purchaseId} expected=${targetAmount} extracted=${extractedAmount} matchedPaymentIndex=${matchedPaymentIndex}`,
      );
      const saved = await this.handleManualReview(
        manager,
        purchase,
        `IA: Monto incorrecto. Esperado: ${targetAmount}, Foto dice: ${extractedAmount}`,
      );
      return {
        purchase: saved,
        action: 'MANUAL_REVIEW',
      };
    }

    // =================================================================
    // FASE 6: APROBACIÓN Y ACTUALIZACIÓN
    // =================================================================

    // Actualizamos el array de pagos
    if (matchedPaymentIndex >= 0) {
      paymentsArray[matchedPaymentIndex].verified = true;
      paymentsArray[matchedPaymentIndex].aiResult = aiResult; // Guardamos evidencia en el item
      purchase.payments = [...paymentsArray]; // Forzamos update de TypeORM
    } else {
      // Fallback legacy: si no hay array, creamos un registro mínimo verificable
      if (paymentsArray.length > 0) {
        paymentsArray[0].verified = true;
        paymentsArray[0].aiResult = aiResult;
        purchase.payments = [...paymentsArray];
      } else {
        const inferredPayment: PaymentEntry = {
          amount: Number(purchase.totalAmount),
          reference: purchase.bankReference || extractedRef,
          currency: purchase.paymentMethod?.currency?.symbol ?? '',
          evidenceUrl: purchase.paymentScreenshotUrl ?? '',
          verified: true,
          aiResult,
          paymentMethodId: purchase.paymentMethodId,
          paymentMethodName: purchase.paymentMethod?.name,
        };
        purchase.payments = [inferredPayment];
      }
    }

    // Recalcular Total Pagado Real
    const newTotalPaid = (purchase.payments ?? [])
      .filter((p) => p.verified)
      .reduce((sum, p) => sum + Number(p.amount), 0);

    purchase.totalPaid = Number(newTotalPaid.toFixed(2));

    let action: PurchaseVerificationAction = 'UPDATED';

    // ¿Ya pagó todo?
    if (purchase.totalPaid >= Number(purchase.totalAmount)) {
      purchase.status = PurchaseStatus.VERIFIED;
      purchase.verifiedAt = new Date();
      purchase.verificationSource = VerificationSource.AI;
      purchase.verifiedByAdmin = null; // Limpiamos si antes lo vio un admin
      purchase.notes = null; // Notas limpias al verificar
      action = 'VERIFIED_NEW';
    } else {
      // Aún falta plata (Abono parcial verificado)
      // Podríamos poner un status PARTIAL_PAYMENT si existiera, o dejar PENDING
    }

    this.logger.log(
      `[processAiWebhook] FASE 6 Final purchaseId=${purchaseId} status=${purchase.status} totalPaid=${purchase.totalPaid} totalAmount=${purchase.totalAmount}`,
    );
    purchase.exportedToSheets = false;
    const updatedPurchase = await manager.save(Purchase, purchase);

    if (updatedPurchase.status === PurchaseStatus.VERIFIED && !wasVerified) {
      this.emitStatusChange(
        updatedPurchase,
        'verified',
        'Verificado por IA exitosamente',
      );
    }

    return {
      purchase: updatedPurchase,
      action,
    };
  }

  /**
   * Normaliza referencias alfanuméricas para comparaciones seguras.
   * - NFKC: convierte fullwidth (ej. OCR) y variantes Unicode a ASCII
   * - Convierte a mayúsculas
   * - Elimina todo lo que no sea letra ni dígito (espacios, guiones, etc.)
   */
  private normalizeReference(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const str = String(raw);
    const normalized = str.normalize('NFKC');
    const upper = normalized.toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9]/g, '');
    return cleaned || null;
  }

  /**
   * Checks if two normalized references match using endsWith or contains logic.
   * Both refs must already be normalized (uppercase, alphanumeric only).
   */
  private isReferenceMatch(
    normalizedRefA: string,
    normalizedRefB: string,
  ): boolean {
    if (!normalizedRefA || !normalizedRefB) return false;

    // endsWith match
    const endsWithMatch =
      normalizedRefA.endsWith(normalizedRefB) ||
      normalizedRefB.endsWith(normalizedRefA);

    // contains match (shorter ref must be at least 4 chars)
    const containsMatch =
      normalizedRefA.includes(normalizedRefB) ||
      normalizedRefB.includes(normalizedRefA);

    const minLengthForContains = 4;
    const shorterRef =
      normalizedRefA.length <= normalizedRefB.length
        ? normalizedRefA
        : normalizedRefB;
    const longerRef =
      normalizedRefA.length > normalizedRefB.length
        ? normalizedRefA
        : normalizedRefB;

    return (
      endsWithMatch ||
      (containsMatch &&
        shorterRef.length >= minLengthForContains &&
        longerRef.includes(shorterRef))
    );
  }

  private async handleManualReview(
    manager: EntityManager,
    purchase: Purchase,
    reason: string,
  ): Promise<Purchase> {
    this.logger.log(
      `[processAiWebhook] Revisión manual purchaseId=${purchase.uid} reason=${reason}`,
    );
    purchase.status = PurchaseStatus.MANUAL_REVIEW;
    purchase.notes = reason;
    purchase.exportedToSheets = false;
    const saved = await manager.save(Purchase, purchase);
    this.emitStatusChange(saved, 'manual_review', reason);
    return saved;
  }

  private emitStatusChange(purchase: Purchase, type: string, msg: string) {
    this.eventEmitter.emit('purchase.status_changed', {
      type,
      msg,
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: purchase.status,
    });
  }
}
