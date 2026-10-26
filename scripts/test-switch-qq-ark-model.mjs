import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { runSwitch, createRpc } from './switch-qq-ark-model.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ark-switch-test-'));
const oldConfig = {
  dsh: { baseUrl: 'http://127.0.0.1:43129', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', authToken: 'existing-local-token' },
  localVoice: { enabled: true, configPath: 'D:/qq-voice/voice-config.json' },
  role: { maxInjectChars: 1234 },
  snowluma: { accessToken: 'existing-qq-token' },
  socialV2: { voice: { enabled: true, dir: 'E:/old-audio', maxPerMinute: 7, maxPerHour: 20 } }
};
const key = 'fixture-ark-key-never-print';
const bridgeRoot = path.join(temp, 'bridge');
fs.mkdirSync(bridgeRoot);
fs.writeFileSync(path.join(bridgeRoot, 'config.json'), JSON.stringify(oldConfig));
const keyFile = path.join(temp, 'ark-key.txt');
fs.writeFileSync(keyFile, `\uFEFF${key}\r\n`);
const backup = path.join(temp, 'original-model.json');
const calls = [];
const modelFields = { provider: 11, model: 11, reasoningEffort: 11 };
const globals = { provider: 'original-global', model: 'original-model', unchangedSetting: 'keep' };
const providers = { zeoapi: { baseURL: 'https://existing.example/api' } };
const schemas = {
  'agent-default-model': { uid: 1, refs: { 1: { type: 'object', dict: modelFields }, 11: { type: 'string' } } },
  'llm-pi-ai': { uid: 1, refs: {
    1: { type: 'object', dict: { providers: 2 } }, 2: { type: 'dict', inner: 3 },
    3: { type: 'object', dict: { api: 11, baseURL: 11, apiKeyEnv: 11, models: 4 } },
    4: { type: 'array', inner: 5 }, 5: { type: 'object', dict: { id: 11, reasoningEfforts: 11, compat: 6 } },
    6: { type: 'object', dict: { thinkingFormat: 11, supportsDeveloperRole: 11, supportsReasoningEffort: 11 } }, 11: { type: 'string' }
  } }
};
const revisions = { 'agent-default-model': 1, 'llm-pi-ai': 1 };
const rpc = async (method, args) => {
  calls.push({ method, args: structuredClone(args) });
  if (method === 'settings/describe') return { namespaces: [
    { ns: 'agent-default-model', value: structuredClone(globals), revision: revisions['agent-default-model'], schema: schemas['agent-default-model'] },
    { ns: 'llm-pi-ai', value: { providers: structuredClone(providers) }, revision: revisions['llm-pi-ai'], schema: schemas['llm-pi-ai'] }
  ] };
  if (method === 'credentials/set') return {};
  if (method === 'settings/mutate') {
    assert.equal(args.expectedRevision, revisions[args.ns]);
    const target = args.ns === 'agent-default-model' ? globals : { providers };
    for (const op of args.ops) {
      const owner = op.path.slice(0, -1).reduce((value, part) => value[part], target);
      if (op.op === 'set') owner[op.path.at(-1)] = structuredClone(op.value);
      else if (op.op === 'unset') delete owner[op.path.at(-1)];
      else throw new Error(`Unexpected operation ${op.op}`);
    }
    revisions[args.ns] += 1;
    return {};
  }
  throw new Error('Unexpected RPC method ' + method);
};

try {
  const result = await runSwitch({ action: 'apply', bridgeRoot, keyFile, backup }, { rpc });
  const changed = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'config.json'), 'utf8'));
  assert.equal(changed.dsh.provider, 'qq-ark-character', 'apply must select the QQ Ark provider in the bridge');
  assert.equal(changed.dsh.model, 'doubao-seed-character-260628');
  assert.equal(changed.dsh.reasoningEffort, 'max');
  for (const field of Object.keys(oldConfig).filter(field => field !== 'dsh')) assert.deepEqual(changed[field], oldConfig[field], field);
  assert.equal(changed.dsh.authToken, oldConfig.dsh.authToken);
  assert.equal(changed.dsh.baseUrl, oldConfig.dsh.baseUrl);
  assert.equal(globals.provider, 'qq-ark-character');
  assert.equal(globals.unchangedSetting, 'keep');
  assert.deepEqual(providers.zeoapi, { baseURL: 'https://existing.example/api' });
  assert.deepEqual(providers['qq-ark-character'].models[0].compat, { thinkingFormat: 'deepseek', supportsDeveloperRole: false, supportsReasoningEffort: true });
  assert.ok(!fs.readFileSync(backup, 'utf8').includes(key));
  assert.ok(!fs.readFileSync(backup, 'utf8').includes('existing-qq-token'));
  assert.ok(!fs.readFileSync(path.join(bridgeRoot, 'config.json'), 'utf8').includes(key));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(result.status, 'applied');

  // Restore both selections, including an originally absent reasoningEffort.
  const restored = await runSwitch({ action: 'restore', bridgeRoot, backup }, { rpc });
  assert.equal(restored.status, 'restored');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'config.json'), 'utf8')), oldConfig);
  assert.deepEqual(globals, { provider: 'original-global', model: 'original-model', unchangedSetting: 'keep' });
  assert.ok(providers['qq-ark-character'], 'restore must not uninstall the provider');
  assert.equal(calls.filter(call => call.method === 'credentials/set').length, 1, 'restore must not alter the credential');

  const beforeBackup = fs.readFileSync(backup, 'utf8');
  const beforeWrites = calls.filter(call => call.method !== 'settings/describe').length;
  await assert.rejects(runSwitch({ action: 'apply', bridgeRoot, keyFile, backup }, { rpc }), /prepare backup failed:.*EEXIST/);
  assert.equal(fs.readFileSync(backup, 'utf8'), beforeBackup);
  assert.equal(calls.filter(call => call.method !== 'settings/describe').length, beforeWrites, 'an existing backup must block all mutations');

  // Remote URLs and incompatible namespaces must fail before credentials or settings are written.
  const beforeReads = calls.length;
  await assert.rejects(runSwitch({ action: 'check', bridgeRoot, dshUrl: 'https://example.com' }, { rpc }), /local loopback/);
  assert.equal(calls.length, beforeReads);
  const badCalls = [];
  await assert.rejects(runSwitch({ action: 'apply', bridgeRoot, keyFile, backup: path.join(temp, 'bad.json') }, {
    rpc: async (method, args) => { badCalls.push({ method, args }); return { namespaces: [] }; }
  }), /inspect DSH failed/);
  assert.deepEqual(badCalls.map(call => call.method), ['settings/describe']);
  assert.equal(fs.existsSync(path.join(temp, 'bad.json')), false);

  // An external failure is surfaced with its exact stage and never retried or converted to success.
  const failedCalls = [];
  await assert.rejects(runSwitch({ action: 'apply', bridgeRoot, keyFile, backup: path.join(temp, 'failed.json') }, {
    rpc: async (method, args) => {
      failedCalls.push(method);
      if (method === 'credentials/set') throw new Error('fixture rejection containing ' + key);
      return rpc(method, args);
    }
  }), error => {
    assert.match(error.message, /save Ark credential failed/);
    assert.ok(!error.message.includes(key));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.deepEqual(failedCalls, ['settings/describe', 'credentials/set']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'config.json'), 'utf8')), oldConfig);
  assert.deepEqual(globals, { provider: 'original-global', model: 'original-model', unchangedSetting: 'keep' });

  const checked = await runSwitch({ action: 'check', bridgeRoot }, { rpc });
  assert.equal(checked.status, 'checked');
  assert.equal(checked.dshUrl, oldConfig.dsh.baseUrl);
  assert.ok(!JSON.stringify(checked).includes('existing-local-token'));
  assert.ok(!JSON.stringify(checked).includes('existing-qq-token'));

  // Exercise the actual HTTP envelope against a local fixture, including no business retry.
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, cookie: req.headers.cookie, body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/settings/describe'
      ? { result: { ok: true, value: { namespaces: [] } } }
      : { result: { ok: false, error: { code: 'fixture-rejected', message: 'denied' } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const realRpc = createRpc(`http://127.0.0.1:${server.address().port}`, { ensureAuth: async () => 'fixture-cookie=private' });
    assert.deepEqual(await realRpc('settings/describe', {}), { namespaces: [] });
    await assert.rejects(realRpc('credentials/set', { ref: 'fixture', value: key }), /credentials\/set: fixture-rejected: denied/);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].cookie, 'fixture-cookie=private');
    assert.equal(requests[1].body.type, 'client-request');
    assert.equal(requests[1].body.method, 'credentials/set');
    assert.deepEqual(requests[1].body.payload, { args: { ref: 'fixture', value: key } });
  } finally { await new Promise(resolve => server.close(resolve)); }

  console.log('PASS QQ Ark switch: apply/restore, preserved voice/config/providers, absent effort restoration, credential secrecy, compatible schema, staged failures, and HTTP RPC contract');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
