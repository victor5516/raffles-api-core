/**
 * Promotion strategies for raffle pricing.
 */
export enum PromotionStrategy {
  NXM = 'nxm',
  PERCENTAGE = 'percentage',
}

/** NxM config: single rule or multiple rules (best price wins). */
export type NxmPromotionConfig =
  | { buy: number; pay: number }
  | { groups: Array<{ buy: number; pay: number }> };

/** Percentage config: discount 0-100. */
export type PercentagePromotionConfig = { percentage: number };

export type PromotionConfig = NxmPromotionConfig | PercentagePromotionConfig;

const ROUND_DECIMALS = 2;

function roundMoney(value: number): number {
  return Math.round(value * Math.pow(10, ROUND_DECIMALS)) / Math.pow(10, ROUND_DECIMALS);
}

function getNxmRules(config: Record<string, unknown>): Array<{ buy: number; pay: number }> {
  if (config.groups && Array.isArray(config.groups)) {
    return (config.groups as Array<{ buy?: number; pay?: number }>)
      .filter((g) => typeof g?.buy === 'number' && typeof g?.pay === 'number' && g.buy >= 1 && g.pay <= g.buy)
      .map((g) => ({ buy: g.buy!, pay: g.pay! }));
  }
  const buy = Number(config.buy);
  const pay = Number(config.pay);
  if (Number.isFinite(buy) && Number.isFinite(pay) && buy >= 1 && pay <= buy) {
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
    let minTotal = basePrice * quantity;
    for (const { buy, pay } of rules) {
      const groups = Math.floor(quantity / buy);
      const remainder = quantity % buy;
      const ticketsToPay = groups * pay + remainder;
      const total = ticketsToPay * basePrice;
      if (total < minTotal) {
        minTotal = total;
      }
    }
    return roundMoney(minTotal);
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
