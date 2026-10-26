// Real MemOS SQLite/retrieval + synthetic loopback embedding/reranker HTTP fixtures.
// No account, DSH process, external API, or downloaded model is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';

import * as implementation from '../src/memos-shadow.js';

test('MemOS Shadow exports the approved factory', () => {
  assert.equal(typeof implementation.createMemosShadow, 'function');
});

async function fixture(t) {
  assert.equal(typeof implementation.createMemosShadow, 'function');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memos-shadow-'));
  const requests = [];
  let failEmbedding = false;
  let failReranker = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/embeddings') {
      if (failEmbedding) { res.writeHead(401); res.end('{"error":"fixture failure"}'); return; }
      const vector = (text) => /香菜|忌口|调味/.test(text) ? [1, 0, 0] : /生日/.test(text) ? [0, 1, 0] : [0, 0, 1];
      res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })) }));
    } else if (req.url === '/rerank') {
      if (failReranker) { res.writeHead(401); res.end('{"error":"fixture failure"}'); return; }
      res.end(JSON.stringify({ results: body.documents.map((text, index) => ({ index, relevance_score: 1 - index / 10 })) }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const keyEnv = `QQ_MEMOS_TEST_${process.pid}`;
  process.env[keyEnv] = 'synthetic-fixture-key';
  const config = { enabled: true, embedding: { endpoint, model: 'fixture-vector-v1', apiKeyEnv: keyEnv }, timeoutMs: 500, topK: 5 };
  const instances = [];
  const open = async (override = {}) => {
    const instance = await implementation.createMemosShadow({ rootDir: temp, config: { ...config, ...override }, logger: () => {} });
    instances.push(instance);
    return instance;
  };
  t.after(async () => {
    for (const instance of instances) await instance.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    delete process.env[keyEnv];
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('qq-memos-shadow-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, requests, config, open, endpoint, keyEnv, failEmbedding: () => { failEmbedding = true; }, failReranker: () => { failReranker = true; } };
}

test('disabled mode leaves no storage or provider traffic; missing remote configuration fails explicitly', async (t) => {
  const f = await fixture(t);
  const shadow = await f.open({ enabled: false });
  assert.equal((await shadow.upsert('private:1', [])).status, 'disabled');
  assert.equal((await shadow.search('private:1', '忌口')).status, 'disabled');
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  await assert.rejects(f.open({ embedding: {} }), { code: 'MEMOS_CONFIG_REQUIRED' });
  await assert.rejects(f.open({ embedding: { ...f.config.embedding, endpoint: 'invalid-url' } }), { code: 'MEMOS_CONFIG_REQUIRED' });
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('real MemOS indexes, recalls semantic paraphrases, keeps sources, and survives reopening', async (t) => {
  const f = await fixture(t);
  let shadow = await f.open();
  const records = [{ id: 'a', text: '我不吃香菜', sourceIds: ['message-1'] }];
  assert.equal((await shadow.upsert('private:1', records)).written, 1);
  assert.equal((await shadow.upsert('private:1', records)).written, 0);
  assert.equal(f.requests.filter((r) => r.url === '/embeddings').length, 1);
  let result = await shadow.search('private:1', '我的饮食忌口');
  assert.equal(result.engine, '@memtensor/memos-local-plugin@2.0.16-beta.1');
  assert.equal(result.mode, 'shadow');
  assert.equal(result.results[0].id, 'a');
  assert.deepEqual(result.results[0].sourceIds, ['message-1']);
  assert.equal(result.embedding.ok, true);
  assert.equal(result.reranker.status, 'disabled');
  assert.equal(Object.hasOwn(result, 'injectedContext'), false);
  assert.ok(f.requests.every((r) => r.authorization === 'Bearer synthetic-fixture-key'));
  await shadow.close();
  shadow = await f.open();
  result = await shadow.search('private:1', '我有哪些调味料不碰');
  assert.equal(result.results[0].id, 'a');
});

test('namespace isolation holds before ranking; update and forget cover vectors, FTS, and source metadata', async (t) => {
  const f = await fixture(t);
  const shadow = await f.open();
  await shadow.upsert('private:1', [{ id: 'same', text: '我不吃香菜', sourceIds: ['a'] }]);
  await shadow.upsert('private:2', [{ id: 'same', text: '香菜是另一个人的忌口', sourceIds: ['b'] }]);
  let result = await shadow.search('private:1', '忌口');
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((r) => r.sourceIds.includes('a')));
  await shadow.upsert('private:1', [{ id: 'same', text: '我的生日是六月一日', sourceIds: ['a2'] }]);
  result = await shadow.search('private:1', '生日');
  assert.equal(result.results[0].text, '我的生日是六月一日');
  assert.deepEqual(result.results[0].sourceIds, ['a2']);
  assert.equal((await shadow.forget('private:1')).deleted, 1);
  assert.deepEqual((await shadow.search('private:1', '生日')).results, []);
  assert.equal((await shadow.search('private:2', '忌口')).results[0].sourceIds[0], 'b');
  assert.equal((await shadow.forget('private:1')).deleted, 0);
});

test('foreign matches cannot consume the limited candidate pool before conversation filtering', async (t) => {
  const f = await fixture(t);
  const shadow = await f.open({ topK: 1 });
  await shadow.upsert('private:2', Array.from({ length: 25 }, (_, i) => ({
    id: `foreign-${i}`, text: `其他会话的香菜忌口${i}`, sourceIds: [`foreign-message-${i}`],
  })));
  await shadow.upsert('private:1', [{ id: 'mine', text: '我的香菜忌口', sourceIds: ['mine'] }]);
  const result = await shadow.search('private:1', '忌口');
  assert.equal(result.candidateCount, 1);
  assert.deepEqual(result.results.map((row) => row.id), ['mine']);
});

test('failed embeddings do not commit partial records and retrieval reports official degraded FTS behavior', async (t) => {
  const f = await fixture(t);
  const shadow = await f.open();
  await shadow.upsert('private:1', [{ id: 'a', text: '我不吃香菜', sourceIds: ['a'] }]);
  f.failEmbedding();
  await assert.rejects(shadow.upsert('private:1', [{ id: 'a', text: '新文字', sourceIds: ['changed'] }]));
  const result = await shadow.search('private:1', '我不吃香菜');
  assert.equal(result.embedding.degraded, true);
  assert.equal(result.results[0].text, '我不吃香菜');
  assert.deepEqual(result.results[0].sourceIds, ['a']);
});

test('optional reranker uses loopback HTTP contract and does not silently claim success on failure', async (t) => {
  const f = await fixture(t);
  const shadow = await f.open({ reranker: { endpoint: `${f.endpoint}/rerank`, model: 'fixture-reranker-v1', apiKeyEnv: f.keyEnv } });
  await shadow.upsert('private:1', [{ id: 'a', text: '我不吃香菜', sourceIds: ['a'] }]);
  const result = await shadow.search('private:1', '饮食忌口');
  assert.equal(result.reranker.status, 'ok');
  assert.equal(result.results[0].rerankScore, 1);
  assert.ok(f.requests.some((r) => r.url === '/rerank' && r.body.model === 'fixture-reranker-v1'));
  f.failReranker();
  await assert.rejects(shadow.search('private:1', '饮食忌口'), { code: 'MEMOS_RERANK_FAILED' });
});

test('local forgetting works while disabled or provider configuration is missing, without creating a missing database', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof implementation.forgetMemosShadow, 'function');
  assert.equal((await implementation.forgetMemosShadow({ rootDir: f.temp, conversationKey: 'private:1' })).deleted, 0);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  const active = await f.open();
  await active.upsert('private:1', [{ id: 'a', text: '我不吃香菜', sourceIds: ['a'] }]);
  await active.upsert('private:2', [{ id: 'a', text: '另一个人的生日', sourceIds: ['b'] }]);
  await active.close();
  const requestCount = f.requests.length;
  delete process.env[f.keyEnv];
  const disabled = await f.open({ enabled: false });
  assert.equal((await disabled.forget('private:1')).deleted, 1);
  await assert.rejects(f.open(), { code: 'MEMOS_CONFIG_REQUIRED' });
  assert.equal((await implementation.forgetMemosShadow({ rootDir: f.temp, conversationKey: 'private:2' })).deleted, 1);
  assert.equal(f.requests.length, requestCount);
  process.env[f.keyEnv] = 'synthetic-fixture-key';
  const reopened = await f.open();
  assert.deepEqual((await reopened.search('private:1', '忌口')).results, []);
  assert.deepEqual((await reopened.search('private:2', '生日')).results, []);
  assert.equal((await reopened.upsert('private:1', [{ id: 'a', text: '新的香菜记录', sourceIds: ['new'] }])).written, 1);
});

test('persisted embedding endpoint and model cannot silently change across reopen', async (t) => {
  const f = await fixture(t);
  const active = await f.open();
  await active.upsert('private:1', [{ id: 'a', text: '我不吃香菜', sourceIds: ['a'] }]);
  await active.close();
  const requestCount = f.requests.length;
  await assert.rejects(f.open({ embedding: { ...f.config.embedding, model: 'different-vector-space' } }), { code: 'MEMOS_EMBEDDING_MISMATCH' });
  await assert.rejects(f.open({ embedding: { ...f.config.embedding, endpoint: `${f.endpoint}/other` } }), { code: 'MEMOS_EMBEDDING_MISMATCH' });
  assert.equal(f.requests.length, requestCount);
  const restored = await f.open();
  assert.equal((await restored.search('private:1', '忌口')).results[0].id, 'a');
});
