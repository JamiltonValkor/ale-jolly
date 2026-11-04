/**
 * Segunda pasada de datos personales en el servidor (la primera es en la VM,
 * OSB-004). Ante la duda, se rechaza: una lección legítima no necesita correos,
 * teléfonos, documentos, URLs con parámetros ni nombres de personas.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** 7 o más dígitos, permitiendo espacios, puntos, guiones y paréntesis entre ellos. */
const PHONE_OR_ID = /(?:\d[\s().-]?){7,}/;
const URL_WITH_QUERY = /https?:\/\/\S+\?\S+/i;
const DOCUMENT = /\b(?:c[ée]dula|c\.c\.|cc|nit|dni|ssn|pasaporte|passport|rut|curp|rfc)\s*[:#]?\s*[A-Z0-9][A-Z0-9.-]{3,}/i;

/** Nombres propios frecuentes (es/en). Una lección habla de prácticas, no de personas. */
const FIRST_NAMES = new Set([
  'ana', 'maria', 'maría', 'laura', 'carolina', 'daniela', 'valentina', 'camila', 'sofia', 'sofía', 'paula', 'andrea',
  'juliana', 'natalia', 'diana', 'sandra', 'claudia', 'patricia', 'luisa', 'isabel', 'gabriela', 'mariana', 'lucia', 'lucía',
  'juan', 'jose', 'josé', 'carlos', 'luis', 'andres', 'andrés', 'jorge', 'miguel', 'david', 'daniel', 'santiago', 'sebastian',
  'sebastián', 'alejandro', 'diego', 'felipe', 'julian', 'julián', 'mateo', 'nicolas', 'nicolás', 'pedro', 'ricardo', 'camilo',
  'jennifer', 'jessica', 'sarah', 'emily', 'emma', 'olivia', 'michael', 'john', 'james', 'robert', 'william', 'jamilton',
]);
const CAPITALIZED_PAIR = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/g;

export type PiiKind = 'email' | 'phone_or_id' | 'url_query' | 'document' | 'person_name';

export function findPii(text: string): PiiKind | null {
  if (EMAIL.test(text)) return 'email';
  if (URL_WITH_QUERY.test(text)) return 'url_query';
  if (DOCUMENT.test(text)) return 'document';
  if (PHONE_OR_ID.test(text)) return 'phone_or_id';
  for (const match of text.matchAll(CAPITALIZED_PAIR)) {
    if (FIRST_NAMES.has((match[1] ?? '').toLowerCase())) return 'person_name';
  }
  for (const word of text.split(/[^\p{L}]+/u)) {
    if (word.length > 1 && word[0] === word[0]?.toUpperCase() && word[0] !== word[0]?.toLowerCase() && FIRST_NAMES.has(word.toLowerCase())) return 'person_name';
  }
  return null;
}
