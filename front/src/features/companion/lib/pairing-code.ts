/**
 * Códigos de sincronización del compañero físico: 8 caracteres de un alfabeto
 * sin los que se confunden al leerlos en una pantalla pequeña (0/O, 1/I/L).
 * Viven 10 minutos y se usan una vez.
 */

export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_PATTERN = /^[2-9A-HJKMNP-Z]{8}$/

/** Separadores que la gente escribe o pega: espacio, guion, punto, punto medio. */
const SEPARATORS = /[\s\-_.·•]/g
const FORBIDDEN = /[01OIL]/

/** Mayúsculas, sin separadores, solo caracteres del alfabeto y como máximo 8. */
export function normalizePairingCode(input: string): string {
  const upper = input.toUpperCase().replace(SEPARATORS, '')
  let out = ''
  for (const char of upper) {
    if (PAIRING_CODE_ALPHABET.includes(char)) out += char
    if (out.length === PAIRING_CODE_LENGTH) break
  }
  return out
}

/** ¿Escribió algún carácter que los códigos nunca usan (0, O, 1, I, L)? */
export function hasForbiddenCharacters(input: string): boolean {
  return FORBIDDEN.test(input.toUpperCase())
}

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code)
}

/** `K7P4QXAB` → `K7P4-QXAB` (así lo muestra la pantalla del robot). */
export function formatPairingCode(code: string): string {
  if (code.length <= 4) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Solo para el transporte de demo: el código real lo genera el back. */
export function generatePairingCode(
  random: () => number = Math.random
): string {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    const index = Math.floor(random() * PAIRING_CODE_ALPHABET.length)
    code += PAIRING_CODE_ALPHABET[index] ?? PAIRING_CODE_ALPHABET[0]
  }
  return code
}
