/** Zona horaria usada para exportaciones (PDF, Excel, Google Sheets). */
export const VENEZUELA_TIMEZONE = 'America/Caracas';

/**
 * Formatea una fecha en hora de Venezuela (America/Caracas) y locale es-VE.
 * Usar en exportación de documentos (PDF, Excel, Google Sheets).
 */
export function formatDateVenezuela(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('es-VE', { timeZone: VENEZUELA_TIMEZONE });
}
