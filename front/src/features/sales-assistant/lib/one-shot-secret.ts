/**
 * Contenedor de la key de IA del dueño (OCF-004). La guarda en un campo
 * privado, no se serializa ni se imprime, y se entrega una sola vez al armar
 * el cuerpo del PUT. Así las `variables` de la mutación en el cache de React
 * Query nunca contienen la key, ni siquiera mientras la petición está en curso.
 */
export class OneShotSecret {
  #value: string | null

  constructor(value: string) {
    this.#value = value
  }

  get consumed(): boolean {
    return this.#value === null
  }

  take(): string {
    const value = this.#value
    if (value === null) throw new Error('Secret already consumed')
    this.#value = null
    return value
  }

  toJSON(): string {
    return '[redacted]'
  }

  toString(): string {
    return '[redacted]'
  }
}
