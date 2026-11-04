/**
 * Un cambio de configuración de la VM por usuario a la vez (OCB-016): `PUT /ai`,
 * `PUT /timezone` y la sincronización previa al start escriben `hermes-config`
 * desde la fila; en serie, ninguno pisa el modelo o la zona del otro.
 */
export class UserLocks {
  private readonly locks = new Map<string, Promise<unknown>>();

  async run<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.locks.set(userId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(userId) === run) this.locks.delete(userId);
    }
  }
}
