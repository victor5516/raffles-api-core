/**
 * Trims string fields of customer data (national_id, full_name, email, phone).
 * Does not trim `location` (it comes from a selector).
 * Accepts both snake_case and camelCase keys.
 * Returns a new object; does not mutate the input.
 */
export function trimCustomerData<T extends Record<string, unknown>>(
  data: T,
): T {
  if (!data || typeof data !== 'object') return data;

  const out = { ...data };
  const setTrimmed = (key: string) => {
    const v = (out as Record<string, unknown>)[key];
    if (typeof v === 'string') (out as Record<string, unknown>)[key] = v.trim();
  };

  setTrimmed('national_id');
  setTrimmed('nationalId');
  setTrimmed('full_name');
  setTrimmed('fullName');
  setTrimmed('email');
  setTrimmed('phone');
  // location is not trimmed (selector); already passed through via spread

  return out;
}
