// Real Bridge initialization/functions, journal, MemOS core, and console HTTP.
// DSH replies and localhost embeddings/reranking are synthetic fixtures, not real APIs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { MemoryJournal } from '../src/memory-journal.js';
import { createMemosShadow } from '../src/memos-shadow.js';

const KEY = 'private:123';
const OTHER = 'group:456';
const MARKER = 'SHADOW_ONLY_SYNTHETIC_MARKER';
const plain = (value) => JSON.parse(JSON.stringify(value));

async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), message);
}

async function fixture(t, { legacy = false, enabled = true } = {}) {
  const requests = [];
  const blockedExternal = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      blockedExternal.push(url.origin);
      return Promise.reject(new Error('E2E fixture permits only loopback HTTP'));
    }
    return originalFetch(input, options);
  };
  let gate;
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: req.url, body, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/embeddings') {
        if (gate && !gate.used) { gate.used = true; gate.started = true; await gate.promise; }
        // All fixture memories share a vector, so isolation cannot pass by chance
        // because a foreign conversation merely has a lower similarity score.
        res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
      } else if (req.url === '/rerank') {
        res.end(JSON.stringify({ results: body.documents.map((_, index) => ({ index, relevance_score: 1 - index / 100 })) }));
      } else { res.writeHead(404); res.end('{}'); }
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const keyEnv = `QQ_MEMORY_E2E_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  process.env[keyEnv] = 'synthetic-e2e-key';
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const shadowConfig = {
    enabled: true, timeoutMs: 5000, topK: 6,
    embedding: { endpoint, model: 'synthetic-vector-v1', apiKeyEnv: keyEnv },
    reranker: { endpoint: `${endpoint}/rerank`, model: 'synthetic-reranker-v1', apiKeyEnv: keyEnv },
  };
  const h = await bridgeHarness({
    config: { socialV2: { longMemory: {
      summarizeEveryMessages: 2, profileEnabled: false, digestEnabled: false,
      shadow: { ...shadowConfig, enabled },
    } } },
    files: legacy ? { 'state/long-memory.json': {
      version: 1, conversations: { [KEY]: [{ t: '2026-10-01 12:00:00', summary: '合成旧摘要：他喜欢清淡饮食', tags: ['偏好'] }] },
      profiles: {}, lastDigest: {},
    } } : {},
  });
  h.setMode('reserved2');
  const consoleServer = h.startConsoleServer();
  if (!consoleServer.listening) await new Promise((resolve) => consoleServer.once('listening', resolve));
  const engines = [];
  t.after(async () => {
    gate?.release();
    try {
      consoleServer.closeAllConnections();
      await new Promise((resolve) => consoleServer.close(resolve));
      for (const engine of engines) await engine.close();
      await h.close();
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      delete process.env[keyEnv];
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(blockedExternal, [], 'No external network attempt is allowed');
  });
  const openCore = async () => {
    const engine = await createMemosShadow({ rootDir: h.temp, config: shadowConfig });
    engines.push(engine);
    return engine;
  };
  const forgetHttp = (key) => fetch(`http://127.0.0.1:${consoleServer.address().port}/api/memory/forget`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    body: JSON.stringify({ key }),
  });
  const logFile = (key) => path.join(h.temp, 'state', 'memory-shadow', crypto.createHash('sha256').update(key).digest('hex') + '.jsonl');
  return {
    h, keyEnv, requests, openCore, forgetHttp, logFile,
    comparisons: (key) => fs.readFileSync(logFile(key), 'utf8').trim().split('\n').map(JSON.parse),
    gateNextEmbedding() {
      gate = { started: false, used: false };
      gate.promise = new Promise((resolve) => { gate.release = resolve; });
      return gate;
    },
  };
}

function incoming(h, key, id, text) {
  h.appendSocialV2Message(key, '合成测试成员', text, text, false, key === KEY, id, [], '123');
}

async function receiveThroughHandler(h, key, id, text) {
  const [kind, conversationId] = key.split(':');
  // Exercise the real inbound routing/normalization/RAW path. Pause automatic
  // wakes only during arrival, then explicitly exercise the wake path below.
  const wasPaused = h.socialV2.paused;
  h.socialV2.paused = true;
  try {
    await h.handleIncoming(kind, conversationId, {
      self_id: 999, user_id: 123, message_id: id,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { nickname: '合成测试成员', card: '合成测试成员' },
    }, h.cfg);
  } finally { h.socialV2.paused = wasPaused; }
}

async function summarize(h, key, memories) {
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    setTimeout(() => {
      for (const waiter of h.learnerWaiters.get(params.sessionId) ?? []) {
        clearTimeout(waiter.timer);
        waiter.resolve(JSON.stringify({ memories }));
      }
      h.learnerWaiters.delete(params.sessionId);
    }, 1);
    return { result: { ok: true, value: {} } };
  };
  h.maybeSummarizeLongMemory(key);
  await h.flushMemoryTasks();
}

test('Bridge RAW→summary fixture→real MemOS→shadow JSONL→HTTP forget→reopened storage', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { legacy: true });
  const { h } = f;
  const fullText = '合成输入：我不吃香菜。' + '全文必须保留。'.repeat(80);
  await receiveThroughHandler(h, KEY, 1, fullText);
  await receiveThroughHandler(h, KEY, 2, '合成输入：我希望回复简短');
  const raw = h.memoryJournal.pending(KEY);
  assert.equal(raw[0].text, fullText);
  const reopenedBeforeExtraction = new MemoryJournal(path.join(h.temp, 'state', 'memory-journal.sqlite'));
  try { assert.deepEqual(reopenedBeforeExtraction.pending(KEY), plain(raw)); }
  finally { reopenedBeforeExtraction.close(); }
  await summarize(h, KEY, [
    { summary: '合成规范摘要：他不吃香菜', tags: ['忌口'] },
    { summary: '合成规范摘要：他喜欢简短回复', tags: ['偏好'] },
  ]);
  const canonical = h.memoryJournal.entries(KEY);
  assert.equal(canonical.length, 2);
  for (const entry of canonical) assert.deepEqual(entry.sourceIds, raw.map((row) => row.id));
  assert.ok(h.calls.prompts.some((p) => p.content[0].text.includes('你是记忆整理器')));
  await receiveThroughHandler(h, OTHER, 1, '另一会话的合成饮食记录');
  await receiveThroughHandler(h, OTHER, 2, '另一会话的合成偏好');
  await summarize(h, OTHER, [{ summary: '另一会话的合成摘要：只属于群聊', tags: [] }]);
  h.queueMemoryShadow(KEY, '我的饮食偏好');
  h.queueMemoryShadow(OTHER, '饮食偏好');
  await h.flushMemoryTasks();
  const first = f.comparisons(KEY).at(-1);
  assert.equal(first.shadow.engine, '@memtensor/memos-local-plugin@2.0.16-beta.1');
  assert.equal(first.shadow.status, 'ok');
  assert.equal(first.shadow.reranker.status, 'ok');
  for (const entry of canonical) {
    const hit = first.shadow.results.find((r) => r.id === entry.id);
    assert.ok(hit, `Canonical memory ${entry.id} must be retrieved`);
    assert.deepEqual(hit.sourceIds, plain(entry.sourceIds));
  }
  const legacy = first.shadow.results.find((row) => row.id.startsWith('legacy-'));
  assert.equal(legacy.text, '合成旧摘要：他喜欢清淡饮食');
  assert.deepEqual(legacy.sourceIds, [], 'Legacy summaries must not invent RAW source IDs');
  assert.ok(first.shadow.results.every((row) => !row.text.includes('另一会话')));
  assert.ok(f.comparisons(OTHER).at(-1).shadow.results.every((row) => row.text.includes('另一会话')));

  // A genuine backend-only record makes a prompt-injection assertion meaningful.
  const core = await f.openCore();
  await core.upsert(KEY, [{ id: 'backend-only', text: `${MARKER} 合成独立记忆`, sourceIds: [] }]);
  await core.close();
  const baseline = h.buildWakePromptV2(KEY, 'at');
  h.queueMemoryShadow(KEY, '我的饮食偏好');
  await h.flushMemoryTasks();
  assert.ok(f.comparisons(KEY).at(-1).shadow.results.some((row) => row.text.includes(MARKER)));
  assert.equal(h.buildWakePromptV2(KEY, 'at'), baseline);
  await h.sendWakePromptV2(KEY, 'at');
  await h.flushMemoryTasks();
  assert.ok(h.calls.prompts.every((p) => !JSON.stringify(p).includes(MARKER)));
  assert.ok(f.requests.some((r) => r.path === '/embeddings'));
  assert.ok(f.requests.some((r) => r.path === '/rerank'));
  assert.ok(f.requests.every((r) => r.authorization === 'Bearer synthetic-e2e-key'));

  const response = await f.forgetHttp(KEY);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(fs.existsSync(f.logFile(KEY)), false);
  await h.cleanupMemory();
  const journal = new MemoryJournal(path.join(h.temp, 'state', 'memory-journal.sqlite'));
  try {
    assert.deepEqual(journal.pending(KEY), []);
    assert.deepEqual(journal.entries(KEY), []);
    assert.equal(journal.epoch(KEY), 1);
    assert.equal(journal.entries(OTHER).length, 1);
  } finally { journal.close(); }
  const reopenedCore = await f.openCore();
  assert.deepEqual((await reopenedCore.search(KEY, '饮食偏好')).results, []);
  assert.equal((await reopenedCore.search(OTHER, '饮食偏好')).results.length, 1);
});

test('HTTP forget removes a pre-existing real MemOS index while Shadow is disabled and credentials are absent', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { enabled: false });
  const { h } = f;
  incoming(h, KEY, 1, '合成记录甲'); incoming(h, KEY, 2, '合成记录乙');
  await summarize(h, KEY, [{ summary: '合成历史记忆', tags: [] }]);
  const core = await f.openCore();
  await core.upsert(KEY, h.memoryJournal.entries(KEY).map((entry) => ({ id: entry.id, text: entry.summary, sourceIds: entry.sourceIds })));
  await core.close();
  delete process.env[f.keyEnv];
  const count = f.requests.length;
  const response = await f.forgetHttp(KEY);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(f.requests.length, count, 'Forgetting cannot depend on a provider request');
  assert.deepEqual(h.memoryJournal.entries(KEY), []);
  process.env[f.keyEnv] = 'synthetic-e2e-key';
  const reopenedCore = await f.openCore();
  assert.deepEqual((await reopenedCore.search(KEY, '合成历史')).results, []);
});

test('HTTP forget waits for active real embedding work and invalidates queued old-epoch Shadow tasks', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { h } = f;
  incoming(h, KEY, 1, '遗忘前的合成消息甲'); incoming(h, KEY, 2, '遗忘前的合成消息乙');
  await summarize(h, KEY, [{ summary: '遗忘前的合成摘要', tags: [] }]);
  const gate = f.gateNextEmbedding();
  h.queueMemoryShadow(KEY, '旧查询一');
  await until(() => gate.started, 'The real embedding request must be in flight');
  h.queueMemoryShadow(KEY, '旧查询二');
  const deletion = f.forgetHttp(KEY);
  await until(() => h.memoryJournal.epoch(KEY) === 1, 'HTTP forget must invalidate the old epoch');
  gate.release();
  const response = await deletion;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  await h.flushMemoryTasks();
  assert.equal(fs.existsSync(f.logFile(KEY)), false, 'Late work cannot restore comparison logs');
  assert.deepEqual(h.memoryJournal.entries(KEY), []);
  const core = await f.openCore();
  assert.deepEqual((await core.search(KEY, '旧查询')).results, []);
});
