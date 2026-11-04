import {isIanaTimezone} from '../contracts/v1';

/**
 * Nombre canónico de una zona IANA válida (OCB-016), o null. Hermes la abre con
 * `zoneinfo.ZoneInfo`, que distingue mayúsculas en Linux: por eso se guarda lo
 * que devuelve `resolvedOptions().timeZone` («america/bogota» → «America/Bogota»).
 */
export function canonicalTimezone(value: string): string | null {
  if (value.length < 1 || value.length > 64 || !isIanaTimezone(value)) return null;
  const canonical = new Intl.DateTimeFormat(undefined, {timeZone: value}).resolvedOptions().timeZone;
  return canonical.length <= 64 && /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(canonical) ? canonical : null;
}
