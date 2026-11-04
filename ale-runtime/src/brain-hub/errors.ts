/** Error del módulo: código fijo y status HTTP, sin entrada ni causa (se traduce en la capa HTTP). */
export class BrainHubError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'REJECTED', readonly status: number) {
    super(code);
    this.name = 'BrainHubError';
  }
}

export const notFound = () => new BrainHubError('NOT_FOUND', 404);
export const forbidden = () => new BrainHubError('FORBIDDEN', 403);
/** Lección con procedencia de plataforma o con datos personales: 422 sin escribir. */
export const rejected = () => new BrainHubError('REJECTED', 422);
export const invalid = () => new BrainHubError('INVALID_REQUEST', 400);
