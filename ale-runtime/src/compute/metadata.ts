import {createHash} from 'node:crypto';

/** Un item de `metadata.items` de Compute Engine. */
export interface MetadataItem { key: string; value: string }

/**
 * Lista cerrada de claves que lee el watcher de la VM, en el orden fijo de
 * `KEYS` en vm/startup-script.sh. El orden es parte del contrato del ack.
 */
export const HERMES_KEYS = [
  'hermes-api-key',
  'hermes-archive-url',
  'hermes-bundle-version',
  'hermes-config',
  'hermes-env',
  'hermes-mcp-tokens',
  'hermes-skills',
  'hermes-soul',
  // ORQA cliente (OSB-005): imagen privada del cerebro, semilla y foto del grafo.
  'hermes-brain-image',
  'hermes-seed-url',
  'hermes-snapshot-url',
  // Restauración de memorias en una VM nueva (D50): GET firmado del último archivo.
  'hermes-restore-url',
  // Especialistas persistentes (MLB-005a/b): tar.gz en base64 de profiles/<n>/..., solo a watchers >= 3.
  'hermes-profiles',
  // Meta native plugin payload and private read-only Kanban projection upload.
  'hermes-extensions',
  'hermes-first-loop-url',
  'hermes-continuous-contexts',
  'hermes-continuous-url',
] as const;
export type HermesKey = typeof HERMES_KEYS[number];
export type HermesMetadata = Partial<Record<HermesKey, string>>;

const sha256hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/**
 * Valor esperado del guest attribute `hermes/applied-version` (vm/README.md):
 * sha256 de las líneas `"<clave> <sha256(valor)>\n"` de cada clave hermes-*
 * presente, en el orden de HERMES_KEYS. Las demás claves no cuentan.
 */
export function computeAppliedVersion(items: readonly MetadataItem[]): string {
  const values = new Map(items.map(item => [item.key, item.value]));
  let lines = '';
  for (const key of HERMES_KEYS) {
    const value = values.get(key);
    if (value !== undefined) lines += `${key} ${sha256hex(Buffer.from(value, 'utf8'))}\n`;
  }
  return sha256hex(lines);
}

export class MetadataMergeError extends Error {
  constructor(readonly reason: 'unknown_hermes_key' | 'template_without_startup_script') {
    super(`METADATA_MERGE_FAILED: ${reason}`);
    this.name = 'MetadataMergeError';
  }
}

/**
 * `instances.insert` con `sourceInstanceTemplate` REEMPLAZA entera la metadata
 * de la plantilla si la instancia trae `metadata.items` (prueba real de OCB-005).
 * Por eso se fusiona por clave: todas las claves de la plantilla (startup-script,
 * enable-guest-attributes, enable-oslogin…) más las hermes-*; una clave
 * repetida la reemplaza el valor hermes-*. Orden estable: plantilla primero.
 */
export function mergeMetadata(template: readonly MetadataItem[], hermes: HermesMetadata): MetadataItem[] {
  if (!template.some(item => item.key === 'startup-script')) throw new MetadataMergeError('template_without_startup_script');
  const extra = Object.keys(hermes).filter(key => !(HERMES_KEYS as readonly string[]).includes(key));
  if (extra.length) throw new MetadataMergeError('unknown_hermes_key');
  const merged = new Map<string, string>();
  for (const item of template) merged.set(item.key, item.value);
  for (const key of HERMES_KEYS) {
    const value = hermes[key];
    if (value !== undefined) merged.set(key, value);
  }
  return [...merged].map(([key, value]) => ({key, value}));
}

/**
 * Reemplaza (o agrega al final) solo las claves dadas sobre TODA la metadata
 * actual de la instancia: startup-script, enable-guest-attributes y las demás
 * hermes-* quedan intactas.
 */
export function withMetadataValues(current: readonly MetadataItem[], values: HermesMetadata): MetadataItem[] {
  const replaced = new Map(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const items = current.map(item => replaced.has(item.key) ? {key: item.key, value: replaced.get(item.key)!} : {...item});
  for (const [key, value] of replaced) if (!current.some(item => item.key === key)) items.push({key, value});
  return items;
}
