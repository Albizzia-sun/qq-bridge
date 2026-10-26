import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'private:123';
async function fixture(t, { memory = {}, globals = {} } = {}) {
  const h = await bridgeHarness({ config: { socialV2: { longMemory: { summarizeEveryMessages: 2, profileEnabled: false, digestEnabled: false, ...memory } } }, globals });
  t.after(() => h.close());
  h.setMode('reserved2');
  return h;
}
function modelReply(h, reply) {
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    setTimeout(() => {
      for (const waiter of h.learnerWaiters.get(params.sessionId) ?? []) {
        clearTimeout(waiter.timer);
        waiter.resolve(reply);
      }
      h.learnerWaiters.delete(params.sessionId);
    }, 1);
    return { result: { ok: true, value: {} } };
  };
}
function incoming(h, id, text = '我喜欢乌龙茶') {
  return h.appendSocialV2Message(key, '小王', text, text, false, true, id, [], '123');
}

test('真实入站函数先保存全文，提取三个条目可追溯，rotation的新seq继续处理', async (t) => {
  const h = await fixture(t);
  incoming(h, 1, '全文'.repeat(400)); incoming(h, 2);
  assert.equal(h.memoryJournal.pending(key)[0].text.length, 800);
  modelReply(h, JSON.stringify({ memories: [1, 2, 3].map(i => ({ summary: `他有偏好${i}`, tags: ['偏好'] })) }));
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  assert.equal(h.memoryJournal.entries(key).length, 3);
  assert.equal(h.longMemoryState.store.conversations[key].length, 3);
  assert.equal(h.memoryJournal.entries(key)[0].sourceIds.length, 2);
  const oldCheckpoint = h.memoryJournal.checkpoint(key).checkpoint;
  h.socialV2.conversations.delete(key);
  incoming(h, 3); incoming(h, 4);
  assert.equal(h.getSocialV2State(key).lastUnreadSeq, 2);
  h.longMemoryState.lastAt.clear();
  modelReply(h, '{"memories":[]}');
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  assert.ok(h.memoryJournal.checkpoint(key).checkpoint > oldCheckpoint);
  assert.equal(h.memoryJournal.entries(key).length, 3);
});

test('非法输出不推进，下一次同批能够成功；sent全文也进入RAW', async (t) => {
  const h = await fixture(t);
  incoming(h, 1); incoming(h, 2);
  modelReply(h, 'not JSON'); h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  assert.equal(h.memoryJournal.checkpoint(key).checkpoint, 0);
  assert.equal(h.longMemoryState.lastAt.has(key), false);
  modelReply(h, '{"summary":"他喜欢乌龙茶","tags":["偏好"]}');
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  assert.equal(h.memoryJournal.entries(key).length, 1);
  h.recordSentMessagesV2(key, ['长回复'.repeat(200)]);
  assert.equal(h.memoryJournal.pending(key)[0].text.length, 600);
});

test('遗忘清理指定层，保留另一个会话、全局文件和聊天调度状态', async (t) => {
  const h = await fixture(t);
  incoming(h, 1); incoming(h, 2);
  modelReply(h, '{"memories":[{"summary":"偏好","tags":[]}]}');
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  h.appendSocialV2Message('group:456', '群友', '群记录', '群记录', false, false, 88);
  const st = h.getSocialV2State(key);
  st.memberImpressions = { 小王: { traits: ['爱茶'] } };
  st.activeTopics = [{ text: '茶' }]; st.pendingThoughts = [{ text: '下次问茶' }];
  h.longMemoryState.store.profiles[key] = { text: '画像' };
  const token = st.agentToken;
  const diary = path.join(h.temp, 'data', '日记', 'diary.jsonl');
  fs.mkdirSync(path.dirname(diary), { recursive: true }); fs.writeFileSync(diary, '原日记');
  const result = await h.forgetConversationMemory(key);
  assert.equal(result.ok, true);
  assert.equal(h.memoryJournal.pending(key).length, 0);
  assert.equal(h.memoryJournal.entries(key).length, 0);
  assert.equal(h.longMemoryState.store.conversations[key], undefined);
  assert.equal(h.longMemoryState.store.profiles[key], undefined);
  assert.deepEqual(Object.keys(st.memberImpressions), []);
  assert.equal(st.activeTopics.length + st.pendingThoughts.length, 0);
  assert.equal(st.agentToken, token);
  assert.equal(st.recentMessages.length, 2);
  assert.equal(h.memoryJournal.pending('group:456').length, 1);
  assert.equal(fs.readFileSync(diary, 'utf8'), '原日记');
});

test('阈值与批次长度分开，空白RAW前缀不会阻塞后续文字', async (t) => {
  const h = await fixture(t, { memory: { summarizeEveryMessages: 3, transcriptLimit: 2 } });
  incoming(h, 1, ' '); incoming(h, 2, '\t');
  incoming(h, 3); incoming(h, 4); incoming(h, 5);
  modelReply(h, '{"memories":[]}');
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.memoryJournal.pendingCount(key), 1);
  assert.equal(h.memoryJournal.pending(key)[0].messageId, '5');
});

test('遗忘期间在途提取、画像与轮换快照均不能恢复旧记忆', async (t) => {
  const h = await fixture(t);
  incoming(h, 1); incoming(h, 2);
  h.getSocialV2State(key).memberImpressions = { 小王: { traits: ['爱茶'] } };
  const snapshot = h.snapshotV2BeforeRotate(key);
  let session;
  h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); session = params.sessionId; return { result: { ok: true } }; };
  h.maybeSummarizeLongMemory(key);
  const deadline = Date.now() + 2000;
  while (!h.learnerWaiters.get(session)?.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
  assert.ok(h.learnerWaiters.get(session)?.length);
  assert.equal((await h.forgetConversationMemory(key)).ok, true);
  for (const waiter of h.learnerWaiters.get(session)) { clearTimeout(waiter.timer); waiter.resolve('{"memories":[{"summary":"旧记忆","tags":[]}]}'); }
  h.learnerWaiters.delete(session);
  await h.flushMemoryTasks();
  h.restoreV2AfterRotate(key, snapshot);
  assert.equal(h.memoryJournal.entries(key).length, 0);
  assert.equal(Object.keys(h.getSocialV2State(key).memberImpressions).length, 0);
  const staleEpoch = h.memoryJournal.epoch(key);
  await h.forgetConversationMemory(key);
  const callsBefore = h.calls.prompts.length;
  await h.refreshProfile(key, '', [], ['旧印象'], staleEpoch);
  assert.equal(h.calls.prompts.length, callsBefore);
  assert.equal(h.longMemoryState.store.profiles[key], undefined);
  const profileTask = h.refreshProfile(key, '', [], ['新一轮材料']);
  const profileDeadline = Date.now() + 2000;
  while (!h.learnerWaiters.get(session)?.length && Date.now() < profileDeadline) await new Promise(r => setTimeout(r, 1));
  assert.ok(h.learnerWaiters.get(session)?.length);
  await h.forgetConversationMemory(key);
  for (const waiter of h.learnerWaiters.get(session)) { clearTimeout(waiter.timer); waiter.resolve('已遗忘材料生成的画像'); }
  h.learnerWaiters.delete(session);
  await profileTask;
  assert.equal(h.longMemoryState.store.profiles[key], undefined);
});

test('Shadow不改提示词，记录对照；API失败不影响聊天，遗忘删除对照', async (t) => {
  const calls = [];
  let fail = false;
  const h = await fixture(t, { globals: { createMemosShadow: async () => ({
    upsert: async (_, rows) => calls.push(['upsert', rows]),
    search: async () => { if (fail) throw new Error('fixture timeout'); return { mode: 'shadow', status: 'ok', results: [{ text: 'SHADOW_ONLY_MARKER' }] }; },
    forget: async () => calls.push(['forget']), close: async () => {},
  }) } });
  incoming(h, 1);
  const baseline = h.buildWakePromptV2(key, 'at');
  h.cfg.socialV2.longMemory.shadow = { enabled: true };
  assert.equal(h.buildWakePromptV2(key, 'at'), baseline);
  await h.sendWakePromptV2(key, 'at'); await h.flushMemoryTasks();
  assert.ok(calls.some(([name]) => name === 'upsert'));
  assert.ok(h.calls.prompts.length > 0);
  assert.ok(h.calls.prompts.every(p => !JSON.stringify(p).includes('SHADOW_ONLY_MARKER')));
  const file = path.join(h.temp, 'state', 'memory-shadow', crypto.createHash('sha256').update(key).digest('hex') + '.jsonl');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).shadow.status, 'ok');
  fail = true;
  h.queueMemoryShadow(key, '再问一次'); await h.flushMemoryTasks();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).shadow.status, 'error');
  assert.equal((await h.forgetConversationMemory(key)).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.ok(calls.some(([name]) => name === 'forget'));
});

test('真实HTTP遗忘仅管理员可用，轻量清空不删除长期条目与RAW', async (t) => {
  const h = await fixture(t);
  incoming(h, 1); incoming(h, 2);
  modelReply(h, '{"memories":[{"summary":"长期条目","tags":[]}]}');
  h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (route, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...extra }, body: JSON.stringify({ key })
  });
  const denied = await call('/api/memory/forget', { 'x-agent-token': h.getSocialV2State(key).agentToken });
  assert.equal(denied.status, 403);
  assert.equal(h.memoryJournal.entries(key).length, 1);
  assert.equal((await call('/api/socialV2/memory-clear')).status, 200);
  assert.equal(h.memoryJournal.entries(key).length, 1);
  assert.equal(h.longMemoryState.store.conversations[key].length, 1);
  const response = await call('/api/memory/forget');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(h.memoryJournal.entries(key).length, 0);
});
