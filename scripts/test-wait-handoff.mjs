// Real bridge HTTP handlers, temporary state and fake QQ/DSH peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    burstPlan: { enabled: true, weights: { 1: 1 } },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}${route.includes('?') ? '&' : '?'}key=${key}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', part => { raw += part; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-peer', text, text, false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  const wait = options => request('wait', { purpose: 'messages', includeUnseen: true, timeoutMs: 1200, quietMs: 100, ...options });
  try { await run({ h, key, st, request, append, wait }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('MCP wait catches the snapshot-to-wait arrival without a long empty wait or implicit acknowledgement', () => fixture(async ({ h, key, st, append, wait }) => {
  append('in snapshot');
  await h.sendWakePromptV2(key, 'question');
  append('arrived while thinking');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await wait();
  assert.equal(result.status, 200);
  assert.ok(result.data.waitedMs < 500);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal(st.lastReadThroughSeq, 0);
  assert.equal(st.unread.length, 2);
}));

test('old HTTP callers still wait only for future arrivals, even with unseen buffered messages', () => fixture(async ({ st, append, request }) => {
  append('unseen before old request');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await request('wait', { purpose: 'messages', timeoutMs: 300, quietMs: 100 });
  assert.ok(result.data.waitedMs >= 300);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
}));

test('buffer catch-up merges actual new arrivals and restarts quiet; only new arrivals grant observation', () => fixture(async ({ st, append, wait }) => {
  append('before request');
  const timer = setTimeout(() => append('during remaining quiet'), 120);
  try {
    const result = await wait({ timeoutMs: 1200, quietMs: 250 });
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [1, 2]);
    assert.ok(result.data.waitedMs >= 330 && result.data.waitedMs < 900);
    assert.equal(result.data.preSleepWaitObserved, true);
    assert.equal(result.data.preSleepWaitSatisfied, false);
  } finally { clearTimeout(timer); }
}));

test('already displayed messages after a visibility gap are not replayed during catch-up', () => fixture(async ({ st, append, request, wait }) => {
  append('unseen first');
  append('already displayed second');
  const partial = await request('unread?limit=1');
  assert.equal(partial.data.readThroughSeq, 0);
  st.lastIncomingAt = Date.now() - 10000;
  const result = await wait();
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [1]);
  assert.equal(result.data.readThroughSeq, 2);
}));

test('unseen arrivals evicted from unread are caught from recent once, without changing acknowledgement', () => fixture(async ({ h, key, st, append, wait }) => {
  h.cfg.socialV2.context.unreadLimit = 1;
  h.cfg.socialV2.context.recentLimit = 100;
  append('in snapshot');
  await h.sendWakePromptV2(key, 'question');
  append('evicted from unread, still unseen in recent');
  append('latest unread');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await wait();
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2, 3]);
  assert.equal(result.data.readThroughSeq, 3);
  assert.equal(st.lastReadThroughSeq, 0);
  assert.deepEqual((await wait({ timeoutMs: 300 })).data.newMessages, []);
  append('next message');
  st.lastIncomingAt = Date.now() - 10000;
  assert.deepEqual((await wait()).data.newMessages.map(m => m.seq), [4]);
}));

test('each historical buffer keeps its own switch and disabling both still permits future delivery', () => fixture(async ({ h, st, append, wait }) => {
  append('unread-only');
  st.recentMessages = [];
  h.cfg.socialV2.tools.getRecent = false;
  st.lastIncomingAt = Date.now() - 10000;
  assert.deepEqual((await wait()).data.newMessages.map(m => m.seq), [1]);
  append('recent-only');
  st.unread = st.unread.filter(m => m.seq !== 2);
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = true;
  st.lastIncomingAt = Date.now() - 10000;
  assert.deepEqual((await wait()).data.newMessages.map(m => m.seq), [2]);
  append('hidden before request');
  h.cfg.socialV2.tools.getRecent = false;
  const timer = setTimeout(() => append('new during wait'), 120);
  try {
    const result = await wait();
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [4]);
    // Seq 2 was removed from unread to isolate recent-only visibility; its
    // receipt is not retained. Neither missing 2 nor hidden 3 may be skipped.
    assert.equal(result.data.readThroughSeq, 1);
  } finally { clearTimeout(timer); }
}));

test('hidden history cannot satisfy minNewMessages and catch-up does not replay on the next wait', () => fixture(async ({ h, st, append, wait }) => {
  append('visible unread');
  append('hidden recent');
  st.unread = st.unread.filter(m => m.seq !== 2);
  h.cfg.socialV2.tools.getRecent = false;
  st.lastIncomingAt = Date.now() - 10000;
  const threshold = await wait({ minNewMessages: 2, timeoutMs: 300 });
  assert.equal(threshold.data.timeout, true);
  assert.deepEqual(threshold.data.newMessages, []);
  assert.equal(threshold.data.readThroughSeq, 0);
  const caught = await wait();
  assert.deepEqual(caught.data.newMessages.map(m => m.seq), [1]);
  const repeated = await wait({ timeoutMs: 300 });
  assert.deepEqual(repeated.data.newMessages, []);
  assert.equal(repeated.data.preSleepWaitObserved, false);
}));

test('catch-up rechecks historical permissions before granting receipts', () => fixture(async ({ h, st, append, wait }) => {
  append('history permission will close');
  const timer = setTimeout(() => {
    h.cfg.socialV2.tools.getUnread = false;
    h.cfg.socialV2.tools.getRecent = false;
  }, 120);
  try {
    const result = await wait({ quietMs: 250, timeoutMs: 400 });
    assert.deepEqual(result.data.newMessages, []);
    assert.equal(result.data.readThroughSeq, 0);
    assert.equal(result.data.arrived, false);
    assert.equal(st.modelSeenSeqs.size, 0);
  } finally { clearTimeout(timer); }
}));

test('invalid catch-up flag is rejected and reply keeps its existing no-observation behavior', () => fixture(async ({ st, append, wait }) => {
  append('not yet seen');
  assert.equal((await wait({ includeUnseen: 'true' })).status, 400);
  st.lastIncomingAt = Date.now() - 10000;
  const result = await wait({ purpose: 'reply' });
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [1]);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal('preSleepWaitRemainingMs' in result.data, false);
}));

test('a new response segment refreshes advice while supplements, repeated reads and empty timeouts do not', () => fixture(async ({ h, key, st, append, request, wait }) => {
  append('wake');
  await h.sendWakePromptV2(key, 'question');
  assert.equal(st.burstAdvice?.count, 1);
  h.cfg.socialV2.burstPlan.weights = { 4: 1 };
  append('supplement before response');
  st.lastIncomingAt = Date.now() - 10000;
  assert.equal((await wait({ purpose: 'reply' })).data.burstPlanCount, 1);
  h.recordSentMessagesV2(key, []);
  append('still same segment');
  assert.equal((await request('unread')).data.burstPlanCount, 1);
  h.recordSentMessagesV2(key, ['fixture successful reply']);
  append('next segment');
  st.lastIncomingAt = Date.now() - 10000;
  assert.equal((await wait()).data.burstPlanCount, 4);
  assert.equal('burstPlanCount' in (await request('recent')).data, false);
  assert.equal('burstPlanCount' in (await wait({ timeoutMs: 300 })).data, false);
  const persisted = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
  assert.equal(JSON.stringify(persisted).includes('burstAdvice'), false);
  assert.equal(JSON.stringify(persisted).includes('waitSeenSeqs'), false);
}));
