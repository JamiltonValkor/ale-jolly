'use client'

/**
 * Stub del modo local: hay un solo negocio y ya está elegido, así que
 * seleccionar no hace nada. Conserva la forma `{ mutate }` de React Query.
 */
export function useSelectBusiness() {
  return { mutate: (_businessId: string) => {}, isPending: false }
}
