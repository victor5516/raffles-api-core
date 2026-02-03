/**
 * Promotion strategies for raffle pricing.
 */
export enum PromotionStrategy {
  NXM = 'nxm',
  PERCENTAGE = 'percentage',
}

export interface NxmRule {
  buy: number;
  pay: number;
}

export interface NxmConfig {
  rules: NxmRule[];
}

/** NxM config: single rule, groups array, or rules array (tiered). */
export type NxmPromotionConfig =
  | { buy: number; pay: number }
  | { groups: NxmRule[] }
  | NxmConfig;

/** Percentage config: discount 0-100. */
export type PercentagePromotionConfig = { percentage: number };

export type PromotionConfig = NxmPromotionConfig | PercentagePromotionConfig;

const ROUND_DECIMALS = 2;

function roundMoney(value: number): number {
  return Math.round(value * Math.pow(10, ROUND_DECIMALS)) / Math.pow(10, ROUND_DECIMALS);
}

function isValidRule(g: { buy?: number; pay?: number }): boolean {
  return (
    typeof g?.buy === 'number' &&
    typeof g?.pay === 'number' &&
    Number.isFinite(g.buy) &&
    Number.isFinite(g.pay) &&
    g.buy >= 1 &&
    g.pay >= 0 &&
    g.pay <= g.buy
  );
}

function getNxmRules(config: Record<string, unknown>): NxmRule[] {
  if (config.rules && Array.isArray(config.rules)) {
    return (config.rules as Array<{ buy?: number; pay?: number }>)
      .filter(isValidRule)
      .map((g) => ({ buy: g.buy!, pay: g.pay! }));
  }
  if (config.groups && Array.isArray(config.groups)) {
    return (config.groups as Array<{ buy?: number; pay?: number }>)
      .filter(isValidRule)
      .map((g) => ({ buy: g.buy!, pay: g.pay! }));
  }
  const buy = Number(config.buy);
  const pay = Number(config.pay);
  if (Number.isFinite(buy) && Number.isFinite(pay) && buy >= 1 && pay >= 0 && pay <= buy) {
    return [{ buy, pay }];
  }
  return [];
}

/**
 * Calculates the total amount to pay for a given quantity applying optional promotion.
 * Pure function: no side effects.
 *
 * @param basePrice - Unit price (in target currency)
 * @param quantity - Number of tickets
 * @param strategy - 'nxm' | 'percentage' | null
 * @param config - Strategy config (e.g. { buy: 5, pay: 4 } or { percentage: 10 })
 * @returns Total amount (rounded to 2 decimals)
 */
export function calculatePromotionalTotal(
  basePrice: number,
  quantity: number,
  strategy: string | null,
  config: object | null,
): number {
  if (quantity < 1 || !Number.isFinite(basePrice) || basePrice < 0) {
    return roundMoney(basePrice * Math.max(0, quantity));
  }

  if (strategy == null || config == null || typeof config !== 'object') {
    return roundMoney(basePrice * quantity);
  }

  const cfg = config as Record<string, unknown>;

  if (strategy === PromotionStrategy.NXM) {
    const rules = getNxmRules(cfg);
    if (rules.length === 0) {
      return roundMoney(basePrice * quantity);
    }
    const sorted = [...rules].sort((a, b) => b.buy - a.buy);
    let remaining = quantity;
    let ticketsToPay = 0;
    for (const { buy, pay } of sorted) {
      const packages = Math.floor(remaining / buy);
      ticketsToPay += packages * pay;
      remaining -= packages * buy;
    }
    ticketsToPay += remaining;
    return roundMoney(ticketsToPay * basePrice);
  }

  if (strategy === PromotionStrategy.PERCENTAGE) {
    const percentage = Number(cfg.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return roundMoney(basePrice * quantity);
    }
    const total = quantity * basePrice * (1 - percentage / 100);
    return roundMoney(total);
  }

  return roundMoney(basePrice * quantity);
}
