/**
 * Stub del modo local: solo las claves de React Query que usa Meta Assistant,
 * con la misma forma que `@/hooks/queries/keys` de SaleADS.
 */
export const queryKeys = {
  businesses: {
    all: ['businesses'] as const,
    lists: () => [...queryKeys.businesses.all, 'list'] as const,
    list: () => [...queryKeys.businesses.lists()] as const,
    details: () => [...queryKeys.businesses.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.businesses.details(), id] as const,
    selected: () => [...queryKeys.businesses.all, 'selected'] as const,
  },
}
