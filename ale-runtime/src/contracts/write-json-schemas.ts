import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {CONTRACTS_V1_DIR, renderContractsV1} from './json-schemas';
import {CONTINUOUS_CONTRACTS_DIR, renderContinuousContracts, renderContinuousRoleCatalog} from './continuous-loop';

/** `npm run contracts:generate`: reescribe contracts/one-click/v1 desde zod. */
const root = resolve(__dirname, '..', '..', '..');
const dir = join(root, CONTRACTS_V1_DIR);
const files = renderContractsV1();
mkdirSync(dir, {recursive: true});
for (const existing of readdirSync(dir)) if (existing.endsWith('.schema.json') && !(existing in files)) rmSync(join(dir, existing));
for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
process.stdout.write(`contracts: ${Object.keys(files).length} files in ${CONTRACTS_V1_DIR}\n`);
const continuous = join(root, CONTINUOUS_CONTRACTS_DIR);
mkdirSync(continuous, {recursive: true});
const allContinuous = renderContinuousContracts();
const brainContracts = join(root, 'brain/saleads_brain/contracts/mcl');
mkdirSync(brainContracts, {recursive: true});
for (const [name, content] of Object.entries(allContinuous)) {
  writeFileSync(join(continuous, name), content);
  writeFileSync(join(brainContracts, name), content);
}
const roleCatalog = renderContinuousRoleCatalog();
writeFileSync(join(continuous, 'role-catalog.json'), roleCatalog);
const continuityPlugin = join(root, 'vm/extensions/saleads-continuity');
mkdirSync(continuityPlugin, {recursive: true});
writeFileSync(join(continuityPlugin, 'role-catalog.json'), roleCatalog);
const pluginContracts=join(root,'vm/extensions/saleads-memory/contracts');
mkdirSync(pluginContracts,{recursive:true});
for(const name of ['knowledge-candidate.schema.json','specialist-experience.schema.json','goal-state.schema.json']) writeFileSync(join(pluginContracts,name),allContinuous[name]!);
process.stdout.write(`contracts: ${Object.keys(allContinuous).length} files in ${CONTINUOUS_CONTRACTS_DIR}\n`);
