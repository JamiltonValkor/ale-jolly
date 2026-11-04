import {createHash} from 'node:crypto';

/**
 * Respuesta de demo mínima y válida contra un JSON Schema (draft 2020-12):
 * solo los campos requeridos, el primer `enum`/rama y valores deterministas.
 * La usan las herramientas que no tienen núcleo con estado. Las pruebas
 * validan cada salida contra su `outputSchema`.
 */

type Schema = Record<string, unknown>;

const uuidFrom = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const CANDIDATES = (seed: string, base: string): string[] => [
  'simulado', 'COP', 'CO', 'es', 'sim_00000001', uuidFrom(seed), '0'.repeat(64), `${base}/sim`,
  new Date().toISOString(), new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 19), 'act_000000000000001',
  '+573000000000', 'a', '0', '0'.repeat(32), `whsec_${'A'.repeat(32)}`, '*',
];

export class Sampler {
  /** Rama de `oneOf`/`anyOf` que se elige (0 = la primera no nula). */
  private branch = 0;

  constructor(private readonly root: Schema, private readonly baseUrl: string) {}

  /** Prueba ramas distintas hasta que la muestra pase `validate` (si se da). */
  sampleValid(validate?: (value: unknown) => boolean): unknown {
    let value: unknown;
    for (this.branch = 0; this.branch < 6; this.branch++) {
      value = this.sample();
      if (!validate || validate(value)) break;
    }
    this.branch = 0;
    return value;
  }

  sample(schema: Schema = this.root, path = '$'): unknown {
    if (schema.$ref) return this.sample(this.resolve(String(schema.$ref)), path);
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
    if (Array.isArray(schema.allOf)) {
      // Base sin allOf; de cada parte se suman sus `required` (también los de `then`) y sus propiedades.
      const {allOf, ...base} = schema;
      const merged: Schema = {...base, properties: {...(base.properties as Schema ?? {})}, required: [...(base.required as string[] ?? [])]};
      for (const part of allOf as Schema[]) {
        for (const source of [part, part.then as Schema | undefined]) {
          if (!source) continue;
          Object.assign(merged.properties as Schema, source.properties ?? {});
          (merged.required as string[]).push(...(source.required as string[] ?? []));
        }
      }
      merged.required = [...new Set(merged.required as string[])];
      return this.sample(merged, path);
    }
    const branches = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
    if (branches?.length) {
      const usable = branches.filter((b) => b.type !== 'null');
      const nonNull = usable.length ? usable[this.branch % usable.length] : branches[0];
      const merged: Schema = {...schema, ...nonNull,
        properties: {...(schema.properties as Schema ?? {}), ...Object.fromEntries(Object.entries(nonNull.properties as Schema ?? {}).filter(([, v]) => v && typeof v === 'object'))},
        required: [...new Set([...(schema.required as string[] ?? []), ...(nonNull.required as string[] ?? [])])]};
      if (!schema.properties && !nonNull.properties) delete merged.properties;
      if (!schema.required && !nonNull.required) delete merged.required;
      delete merged.oneOf; delete merged.anyOf;
      return this.sample(merged, path);
    }
    const types = Array.isArray(schema.type) ? schema.type as string[] : schema.type ? [String(schema.type)] : schema.properties ? ['object'] : [];
    const type = types.find((t) => t !== 'null') ?? types[0];
    switch (type) {
      case 'object': return this.object(schema, path);
      case 'array': {
        const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
        return Array.from({length: min}, (_, i) => this.sample((schema.items ?? {}) as Schema, `${path}[${i}]`));
      }
      case 'string': return this.string(schema, path);
      case 'integer': return this.number(schema, true);
      case 'number': return this.number(schema, false);
      case 'boolean': return false;
      case 'null': return null;
      default: return types.length === 0 ? {} : null;
    }
  }

  private object(schema: Schema, path: string): Record<string, unknown> {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Record<string, unknown> = {};
    for (const key of (schema.required ?? []) as string[]) {
      out[key] = this.sample(properties[key] ?? {}, `${path}.${key}`);
    }
    const min = typeof schema.minProperties === 'number' ? schema.minProperties : 0;
    for (const key of Object.keys(properties)) {
      if (Object.keys(out).length >= min) break;
      if (!(key in out)) out[key] = this.sample(properties[key], `${path}.${key}`);
    }
    if (Object.keys(out).length < min && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const names = (schema.propertyNames as Schema | undefined) ?? {type: 'string'};
      while (Object.keys(out).length < min) {
        const key = this.string(names, `${path}.key${Object.keys(out).length}`) + (Object.keys(out).length || '');
        out[key] = this.sample(schema.additionalProperties as Schema, `${path}.${key}`);
      }
    }
    return out;
  }

  private string(schema: Schema, path: string): string {
    const format = schema.format;
    let value: string;
    if (format === 'uuid') value = uuidFrom(path);
    else if (format === 'date-time') value = new Date().toISOString();
    else if (format === 'date') value = new Date().toISOString().slice(0, 10);
    else if (format === 'uri' || format === 'url') value = `${this.baseUrl}/sim`;
    else if (format === 'email') value = 'demo-owner@saleads.local';
    else value = 'simulado';
    const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
    const max = typeof schema.maxLength === 'number' ? schema.maxLength : Infinity;
    if (typeof schema.pattern === 'string') {
      const re = new RegExp(schema.pattern, 'u');
      if (!re.test(value)) value = CANDIDATES(path, this.baseUrl).find((c) => re.test(c) && c.length >= min && c.length <= max) ?? value;
    }
    if (value.length < min) value = value.padEnd(min, 'x');
    if (value.length > max) value = value.slice(0, max);
    return value;
  }

  private number(schema: Schema, integer: boolean): number {
    let value = 0;
    if (typeof schema.minimum === 'number') value = schema.minimum;
    if (typeof schema.exclusiveMinimum === 'number') value = schema.exclusiveMinimum + (integer ? 1 : 0.5);
    if (typeof schema.maximum === 'number' && value > schema.maximum) value = schema.maximum;
    return integer ? Math.ceil(value) : value;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith('#/')) return {};
    return ref.slice(2).split('/').reduce<unknown>((node, part) => (node as Schema)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], this.root) as Schema ?? {};
  }
}
