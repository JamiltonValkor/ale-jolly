import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {MAX_SKILLS_METADATA_BYTES, SkillsTooLargeError} from '../skills/skills-writer';
import {metadataTar} from './metadata-archive';

/** Fixed assets only: no user path, executable body or external URL in the request contract. */
export const META_EXTENSION_FILES = Object.freeze({
  'plugins/saleads-meta-search/plugin.yaml': 'saleads-meta-search/plugin.yaml',
  'plugins/saleads-meta-search/__init__.py': 'saleads-meta-search/__init__.py',
  'plugins/saleads-meta-search/search.py': 'saleads-meta-search/search.py',
  'runtime/first-loop-exporter.py': 'first-loop-exporter.py',
  'plugins/saleads-continuity/plugin.yaml': 'saleads-continuity/plugin.yaml',
  'plugins/saleads-continuity/__init__.py': 'saleads-continuity/__init__.py',
  'plugins/saleads-continuity/context.py': 'saleads-continuity/context.py',
  'plugins/saleads-continuity/role-catalog.json': 'saleads-continuity/role-catalog.json',
  'plugins/saleads-continuity/notifications.py': 'saleads-continuity/notifications.py',
  'plugins/saleads-continuity/delivery.py': 'saleads-continuity/delivery.py',
  'plugins/saleads-continuity/turn_frames.py': 'saleads-continuity/turn_frames.py',
  'plugins/saleads-continuity/goal_delivery.py': 'saleads-continuity/goal_delivery.py',
  'plugins/saleads-continuity/run_receipts.py': 'saleads-continuity/run_receipts.py',
  'runtime/continuous-exporter.py': 'continuous-exporter.py',
  'plugins/saleads-memory/plugin.yaml': 'saleads-memory/plugin.yaml',
  'plugins/saleads-memory/__init__.py': 'saleads-memory/__init__.py',
  'plugins/saleads-memory/client.py': 'saleads-memory/client.py',
  'plugins/saleads-memory/context.py': 'saleads-memory/context.py',
  'plugins/saleads-memory/memory.py': 'saleads-memory/memory.py',
  'plugins/saleads-memory/schemas.py': 'saleads-memory/schemas.py',
  'plugins/saleads-memory/source_capture.py': 'saleads-memory/source_capture.py',
  'plugins/saleads-memory/specialist_capture.py': 'saleads-memory/specialist_capture.py',
  'plugins/saleads-memory/landing_experience.py': 'saleads-memory/landing_experience.py',
  'plugins/saleads-memory/dispatch.py': 'saleads-memory/dispatch.py',
  'plugins/saleads-memory/turn_frames.py': 'saleads-continuity/turn_frames.py',
  'plugins/saleads-memory/contracts/knowledge-candidate.schema.json': 'saleads-memory/contracts/knowledge-candidate.schema.json',
  'plugins/saleads-memory/contracts/specialist-experience.schema.json': 'saleads-memory/contracts/specialist-experience.schema.json',
  'plugins/saleads-memory/contracts/goal-state.schema.json': 'saleads-memory/contracts/goal-state.schema.json',
  'runtime/curation-dispatcher.py': 'curation-dispatcher.py',
  'runtime/landing-pilot/cli/landing_cli.py': 'landing-pilot/cli/landing_cli.py',
  'runtime/landing-pilot/cli/README.md': 'landing-pilot/cli/README.md',
  'runtime/landing-pilot/build_metadata.py': 'landing-pilot/build_metadata.py',
});

export function metaRuntimeExtensions(assetDir = resolve(process.cwd(), 'vm/extensions')): string {
  const files = Object.fromEntries(Object.entries(META_EXTENSION_FILES).map(([entry, asset]) => [
    entry, readFileSync(resolve(assetDir, asset), 'utf8'),
  ]));
  const value = gzipSync(metadataTar(files), {level: 9}).toString('base64');
  if (Buffer.byteLength(value) > MAX_SKILLS_METADATA_BYTES) throw new SkillsTooLargeError(Buffer.byteLength(value));
  return value;
}
