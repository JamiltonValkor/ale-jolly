import type {ApprovalRow} from '../approvals/approvals-repository';
import type {ApprovalCatalog, ApprovalExecutor} from '../approvals/approvals.service';
import type {BrainHubService} from '../brain-hub/service';
import type {ApprovalItemV1, ApprovalKindV1} from '../contracts/v1';
import type {SkillsWriter} from './skills-writer';

/**
 * Catálogo de habilidades para las aprobaciones (OSB-016). Resuelve el ítem
 * público vigente y registra lo propuesto o rechazado para no insistir.
 * `install_mcp` no tiene ítems todavía: no se resuelve ni se ejecuta.
 */
export class SkillsApprovalCatalog implements ApprovalCatalog {
  constructor(private readonly brainHub: BrainHubService) {}

  async resolve({userId, kind, itemId}: {userId: string; businessId: string; kind: ApprovalKindV1; itemId: string}): Promise<ApprovalItemV1 | null> {
    if (kind === 'install_mcp') return null;
    if (kind === 'uninstall_skill') {
      const version = await this.brainHub.installedVersion(userId, itemId);
      const item = version ? await this.brainHub.itemVersion(itemId, version) : null;
      return item && item.kind === 'skill' ? {id: item.id, name: item.name, version: item.version, summary: item.summary} : null;
    }
    const item = await this.brainHub.activeItem(itemId);
    return item && item.kind === 'skill' ? {id: item.id, name: item.name, version: item.version, summary: item.summary} : null;
  }

  async onProposed(row: ApprovalRow): Promise<void> {
    if (row.kind === 'install_skill') await this.brainHub.recordInstall(row.user_id, row.item_id, row.item_version, 'proposed');
  }

  async onRejected(row: ApprovalRow): Promise<void> {
    if (row.kind === 'install_skill') await this.brainHub.recordInstall(row.user_id, row.item_id, row.item_version, 'rejected');
  }
}

/** Instalar una skill aprobada: STALE si el catálogo ya tiene otra versión activa. */
export class InstallSkillExecutor implements ApprovalExecutor {
  readonly kind = 'install_skill' as const;
  constructor(private readonly brainHub: BrainHubService, private readonly writer: SkillsWriter) {}

  async isStale(row: ApprovalRow): Promise<boolean> {
    return (await this.brainHub.activeItem(row.item_id))?.version !== row.item_version;
  }

  async execute(row: ApprovalRow): Promise<Record<string, unknown>> {
    await this.brainHub.recordInstall(row.user_id, row.item_id, row.item_version, 'installed');
    const applied = await this.writer.apply(row.user_id, await this.brainHub.installedFiles(row.user_id));
    return {item_id: row.item_id, version: row.item_version, applied};
  }
}

/** Desinstalar: STALE si ya no está instalada esa versión. Las skills del agente no se tocan. */
export class UninstallSkillExecutor implements ApprovalExecutor {
  readonly kind = 'uninstall_skill' as const;
  constructor(private readonly brainHub: BrainHubService, private readonly writer: SkillsWriter) {}

  async isStale(row: ApprovalRow): Promise<boolean> {
    return (await this.brainHub.installedVersion(row.user_id, row.item_id)) !== row.item_version;
  }

  async execute(row: ApprovalRow): Promise<Record<string, unknown>> {
    await this.brainHub.recordInstall(row.user_id, row.item_id, row.item_version, 'uninstalled');
    const applied = await this.writer.apply(row.user_id, await this.brainHub.installedFiles(row.user_id));
    return {item_id: row.item_id, version: row.item_version, applied};
  }
}
