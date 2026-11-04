import {z} from 'zod';
import {
  AdminCatalogResponse, AdminLessonsResponse, CatalogView, OwnerLessonsResponse, PublishRequest, PublishResponse, SharingPreference,
  SharingUpdateRequest,
} from '../brain-hub/contracts';
import {CONTRACTS_V1} from './v1';

/** Contratos web del buzón y el catálogo del Cerebro SaleADS (OSB-015/016), viven en su módulo extraíble. */
export const BRAIN_HUB_CONTRACTS_V1 = {
  'catalog-view': CatalogView,
  'learning-sharing': SharingPreference,
  'learning-sharing-update-request': SharingUpdateRequest,
  'owner-lessons-response': OwnerLessonsResponse,
  'admin-lessons-response': AdminLessonsResponse,
  'admin-catalog-response': AdminCatalogResponse,
  'publish-request': PublishRequest,
  'publish-response': PublishResponse,
} as const;

export const CONTRACTS_V1_DIR = 'contracts/one-click/v1';

/** Renderiza cada contrato zod a JSON Schema (draft 2020-12), con salida estable. */
export function renderContractsV1(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries({...CONTRACTS_V1, ...BRAIN_HUB_CONTRACTS_V1})) {
    const json = {
      $id: `https://saleads.ai/contracts/one-click/v1/${name}.schema.json`,
      ...z.toJSONSchema(schema, {target: 'draft-2020-12'}),
    };
    files[`${name}.schema.json`] = `${JSON.stringify(json, null, 2)}\n`;
  }
  return files;
}
