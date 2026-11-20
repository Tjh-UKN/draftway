import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const entry = pathToFileURL(process.argv[1]);
const {SettingsManager, getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, resolveModelScopeWithDiagnostics}
  = await Promise.all(['config.js', 'core/settings-manager.js', 'core/trust-manager.js', 'core/model-resolver.js']
    .map(file => import(new URL(file, entry)))).then(parts => Object.assign({}, ...parts)).catch(() => import(entry.href));
const cwd = process.cwd();
const agentDir = getAgentDir();
const global = SettingsManager.create(cwd, agentDir, {projectTrusted: false});
const trusted = !hasTrustRequiringProjectResources(cwd) ||
  (new ProjectTrustStore(agentDir).get(cwd) ?? (global.getDefaultProjectTrust() === 'always'));
const patterns = (trusted ? SettingsManager.create(cwd, agentDir, {projectTrusted: true}) : global).getEnabledModels();
const inventory = JSON.parse(readFileSync(0, 'utf8'));
const {scopedModels} = patterns?.length
  ? await resolveModelScopeWithDiagnostics(patterns, {getAvailable: async () => inventory})
  : {scopedModels: []};
console.log(JSON.stringify(scopedModels.map(({model}) => `${model.provider}/${model.id}`)));
