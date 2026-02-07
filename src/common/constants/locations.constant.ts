/**
 * Estados de Venezuela (lista oficial) + OTRO para validación del campo state en location.
 * Útil para validar el JSONB location sin restringir otros campos futuros.
 */
export const VENEZUELA_STATES = [
  'Amazonas',
  'Anzoátegui',
  'Apure',
  'Aragua',
  'Barinas',
  'Bolívar',
  'Carabobo',
  'Cojedes',
  'Delta Amacuro',
  'Falcón',
  'Guárico',
  'Lara',
  'La Guaira',
  'Mérida',
  'Miranda',
  'Monagas',
  'Nueva Esparta',
  'Portuguesa',
  'Sucre',
  'Táchira',
  'Trujillo',
  'Vargas',
  'Yaracuy',
  'Zulia',
  'Distrito Capital',
  'OTRO',
] as const;

export type VenezuelaState = (typeof VENEZUELA_STATES)[number];
