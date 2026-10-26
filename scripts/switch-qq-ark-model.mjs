// Manual cloud-machine model switch. This script never restarts DSH/QQ or sends messages.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODEL_FIELDS = ['provider', 'model', 'reasoningEffort'];
export const TARGET_SELECTION = { provider: 'qq-ark-character', model: 'doubao-seed-character-260628', reasoningEffort: 'max' };
export const PROVIDER_CONFIG = {
  apiKeyEnv: 'QQ_ARK_API_KEY', api: 'openai-completions',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  models: [{
    id: TARGET_SELECTION.model, name: 'Doubao Seed Character',
    contextWindow: 131072, maxTokens: 32768, input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
    compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, supportsReasoningEffort: true }
  }]
};

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const selectFields = value => Object.fromEntries(MODEL_FIELDS.filter(field => Object.hasOwn(value || {}, field)).map(field => [field, value[field]]));
const sameSelection = (left, right) => MODEL_FIELDS.every(field => Object.hasOwn(left, field) === Object.hasOwn(right, field) && left[field] === right[field]);

function localBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DSH URL must be a local loopback origin such as http://127.0.0.1:43129');
  }
  return url.origin;
}

export function createRpc(base, client, request = fetch) {
  return async (method, args) => {
    const signal = AbortSignal.timeout(15000);
    const cookie = await client.ensureAuth(signal);
    const response = await request(`${base}/api/${method}`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const envelope = await response.json();
    if (!envelope.result?.ok) {
      const error = envelope.result?.error;
      throw new Error(`${method}: ${error?.code || 'invalid-response'}: ${error?.message || 'RPC did not succeed'}`);
    }
    return envelope.result.value;
  };
}

async function connect(bridgeRoot, config, base) {
  const moduleFile = path.join(bridgeRoot, 'src', 'dsh-client.js');
  const { NodeApiClient } = await import(pathToFileURL(moduleFile).href);
  const client = new NodeApiClient(base, 15000, {
    token: config.dsh?.authToken || '', tokenExplicit: Boolean(config.dsh?.authToken), allowRemote: false
  });
  return createRpc(base, client);
}

function schemaNode(namespace, id = namespace.schema?.uid) {
  return namespace.schema?.refs?.[id];
}

function namespacesFrom(description) {
  const list = description?.namespaces;
  const provider = list?.find(item => item.ns === 'llm-pi-ai');
  const defaults = list?.find(item => item.ns === 'agent-default-model');
  for (const entry of [provider, defaults]) {
    if (!entry || !Number.isFinite(entry.revision) || schemaNode(entry)?.type !== 'object') {
      throw new Error('DSH must expose llm-pi-ai and agent-default-model with writable schema/revision metadata');
    }
  }
  const providerMap = schemaNode(provider, schemaNode(provider).dict?.providers);
  const providerFields = schemaNode(provider, providerMap?.inner)?.dict;
  const modelArray = schemaNode(provider, providerFields?.models);
  const modelFields = schemaNode(provider, modelArray?.inner)?.dict;
  const compatFields = schemaNode(provider, modelFields?.compat)?.dict;
  if (providerMap?.type !== 'dict' || !['apiKeyEnv', 'api', 'baseURL', 'models'].every(field => providerFields?.[field] !== undefined)
    || !['id', 'reasoningEfforts', 'compat'].every(field => modelFields?.[field] !== undefined)
    || !['thinkingFormat', 'supportsDeveloperRole', 'supportsReasoningEffort'].every(field => compatFields?.[field] !== undefined)
    || !MODEL_FIELDS.every(field => schemaNode(defaults).dict?.[field] !== undefined)) {
    throw new Error('This DSH schema does not expose the required custom provider/model configuration');
  }
  if (typeof defaults.value?.provider !== 'string' || !defaults.value.provider
    || typeof defaults.value?.model !== 'string' || !defaults.value.model) {
    throw new Error('The original DSH default model cannot be captured for later restoration');
  }
  return { provider, defaults };
}

async function describe(rpc) { return namespacesFrom(await rpc('settings/describe', {})); }

function modelOps(selection) {
  return MODEL_FIELDS.map(field => Object.hasOwn(selection, field)
    ? { op: 'set', path: [field], value: selection[field] }
    : { op: 'unset', path: [field] });
}

/** rpc injection is used only by local tests; real CLI calls the existing bridge auth client. */
export async function runSwitch(options, dependencies = {}) {
  let stage = 'read configuration';
  let key = '';
  try {
    if (!['check', 'apply', 'restore'].includes(options.action)) throw new Error('Action must be check, apply, or restore');
    if (!options.bridgeRoot) throw new Error('--bridge-root is required');
    const bridgeRoot = path.resolve(options.bridgeRoot);
    const configFile = path.join(bridgeRoot, 'config.json');
    const config = readJson(configFile);
    const base = localBase(options.dshUrl || config.dsh?.baseUrl);
    const rpc = dependencies.rpc || await connect(bridgeRoot, config, base);
    stage = 'inspect DSH';
    let settings = await describe(rpc);
    if (options.action === 'check') return {
      status: 'checked', node: process.version, dshUrl: base,
      bridgeSelection: selectFields(config.dsh), globalSelection: selectFields(settings.defaults.value),
      customProviderAvailable: true, targetModel: TARGET_SELECTION.model
    };
    if (!options.backup) throw new Error('--backup is required');
    const backupFile = path.resolve(options.backup);
    let selection;
    let backup;
    if (options.action === 'apply') {
      stage = 'prepare backup';
      if (!options.keyFile) throw new Error('--key-file is required for apply');
      key = fs.readFileSync(options.keyFile, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!key) throw new Error('The Ark API key file is empty');
      backup = {
        version: 1, bridgeRoot, bridgeDshExisted: Object.hasOwn(config, 'dsh'),
        bridgeSelection: selectFields(config.dsh), globalSelection: selectFields(settings.defaults.value)
      };
      // An existing backup must remain the original selection, never the later target.
      fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2) + '\n', { flag: 'wx' });
      stage = 'save Ark credential';
      await rpc('credentials/set', { ref: PROVIDER_CONFIG.apiKeyEnv, value: key });
      stage = 'configure Ark provider';
      await rpc('settings/mutate', {
        ns: settings.provider.ns, expectedRevision: settings.provider.revision,
        ops: [{ op: 'set', path: ['providers', TARGET_SELECTION.provider], value: PROVIDER_CONFIG }]
      });
      settings = await describe(rpc);
      const installed = settings.provider.value?.providers?.[TARGET_SELECTION.provider];
      if (installed?.baseURL !== PROVIDER_CONFIG.baseURL || installed?.apiKeyEnv !== PROVIDER_CONFIG.apiKeyEnv
        || !installed.models?.some(model => model.id === TARGET_SELECTION.model)) {
        throw new Error('The requested Ark provider was not confirmed by DSH');
      }
      selection = TARGET_SELECTION;
    } else {
      stage = 'read original selection';
      backup = readJson(backupFile);
      if (backup.version !== 1 || path.resolve(backup.bridgeRoot || '') !== bridgeRoot
        || !backup.globalSelection?.provider || !backup.globalSelection?.model || !backup.bridgeSelection) {
        throw new Error('Backup does not describe this bridge and its original model selections');
      }
      selection = backup.globalSelection;
    }
    stage = 'set global model';
    await rpc('settings/mutate', {
      ns: settings.defaults.ns, expectedRevision: settings.defaults.revision, ops: modelOps(selection)
    });
    settings = await describe(rpc);
    if (!sameSelection(selectFields(settings.defaults.value), selection)) throw new Error('DSH did not confirm the requested global model selection');
    stage = 'write QQ model configuration';
    // Read again so unrelated fields edited during the RPC round-trip are preserved.
    const latest = readJson(configFile);
    latest.dsh ??= {};
    for (const field of MODEL_FIELDS) delete latest.dsh[field];
    Object.assign(latest.dsh, options.action === 'apply' ? TARGET_SELECTION : backup.bridgeSelection);
    if (options.action === 'restore' && !backup.bridgeDshExisted && Object.keys(latest.dsh).length === 0) delete latest.dsh;
    fs.writeFileSync(configFile, JSON.stringify(latest, null, 2) + '\n');
    return {
      status: options.action === 'apply' ? 'applied' : 'restored', backupFile,
      bridgeSelection: selectFields(latest.dsh), globalSelection: selectFields(settings.defaults.value),
      restartRequired: 'Start the QQ bridge through its existing launcher. Existing DSH sessions keep their own selected model.'
    };
  } catch (error) {
    let message = String(error?.message || error);
    if (key) message = message.replaceAll(key, '[REDACTED]');
    throw new Error(`${stage} failed: ${message}`);
  }
}

function parseArgs(argv) {
  const options = { action: argv[0] };
  const names = { '--bridge-root': 'bridgeRoot', '--dsh-url': 'dshUrl', '--key-file': 'keyFile', '--backup': 'backup' };
  for (let i = 1; i < argv.length; i += 2) {
    if (!names[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid option: ' + argv[i]);
    options[names[argv[i]]] = argv[i + 1];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runSwitch(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
