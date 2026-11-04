/** R15: opciones de un conteo con variante por confirmar y la pregunta que hace Jolly. */
export interface VariantOption {variante_id: string; nombre: string}

export const optionNames = (options: VariantOption[]): string => {
  const names = options.map(option => option.nombre);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} o ${names.at(-1)}` : names.join('');
};

/** La escribe el servidor y nunca trae un reparto sugerido: un «sí» a «cinco y cinco» sería el reparto del modelo. */
export const variantQuestion = (payload: {contado?: number; producto?: string; opciones?: VariantOption[]}): string =>
  `Conté ${payload.contado} de ${payload.producto} y no distingo ${optionNames(payload.opciones ?? [])}. ¿Cuántos hay de cada una?`.slice(0, 240);
