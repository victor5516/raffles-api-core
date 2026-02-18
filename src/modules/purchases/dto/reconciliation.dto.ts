import { Purchase } from '../entities/purchase.entity';

export interface BankTransaction {
  /**
   * Fecha normalizada en formato YYYY-MM-DD
   */
  date: string;
  /**
   * Monto de la transacción (positivo para créditos)
   */
  amount: number;
  /**
   * Referencia bancaria normalizada (sin formateo)
   */
  reference: string;
  /**
   * Descripción libre de la transacción según el estado de cuenta
   */
  description: string;
  /**
   * Fecha original tal como aparece en el estado de cuenta (para depuración)
   */
  rawDate?: string;
}

export interface ReconciliationResultMatch {
  purchaseId: string;
  bankRef: string;
  amount: number;
  diff: number;
}

export interface ReconciliationResultMetadata {
  totalBank: number;
  totalDb: number;
  range: {
    start: Date;
    end: Date;
  };
}

export interface ReconciliationResult {
  matched: ReconciliationResultMatch[];
  /**
   * Compras en DB que no aparecen en el estado de cuenta
   * (posibles fraudes o pagos no recibidos)
   */
  unmatchedDb: Purchase[];
  /**
   * Transacciones en el estado de cuenta que no tienen compra asociada en DB
   * (dinero en banco sin orden registrada)
   */
  unmatchedBank: BankTransaction[];
  metadata: ReconciliationResultMetadata;
}

