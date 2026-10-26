import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { z } from 'zod';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'private:123';
const target = '测试用户';
const plain = (value) => JSON.parse(JSON.stringify(value));

async function fixture(t, options = {}) {
  const h = await bridgeHarness({ config: { socialV2: { longMemory: {
    profileRefreshTurns: 5, digestEnabled: false,
  } } }, ...options });
  h.setMode('reserved2');
  t.after(() => h.close());
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  h.post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: JSON.stringify({ key, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  h.append = (content, oldContent) => h.post('memory-append', {
    category: 'memberImpression', content, extra: { target, ...(oldContent === undefined ? {} : { oldContent }) },
  });
  return h;
}

function seed(h, traits = ['他总是逞强', '喜欢清淡食物']) {
  const st = h.getSocialV2State(key);
  st.memberImpressions[target] = { traits, interactionCount: 2, lastSeenAt: 1 };
  h.longMemoryState.store.profiles[key] = { text: 'OLD_PROFILE_MARKER', updatedAt: '2026-01-01', turns: 3 };
  return st;
}

function modelReply(h, text) {
  h.api.sessions.prompt = async params => {
    h.calls.prompts.push(params);
    setTimeout(() => {
      for (const waiter of h.learnerWaiters.get(params.sessionId) ?? []) {
        clearTimeout(waiter.timer); waiter.resolve(text);
      }
      h.learnerWaiters.delete(params.sessionId);
    }, 1);
    return { result: { ok: true, value: {} } };
  };
}

test('印象满十条后保留最近十条，新纠正不会在下一次追加时丢失', async t => {
  const h = await fixture(t);
  seed(h, Array.from({ length: 10 }, (_, i) => `旧观察${i}`));
  await h.append('当前明确说喜欢独处');
  await h.append('新观察');
  const traits = plain(h.getSocialV2State(key).memberImpressions[target].traits);
  assert.equal(traits.length, 10);
  assert.ok(traits.includes('当前明确说喜欢独处'));
  assert.ok(!traits.includes('旧观察0'));
});

test('指定旧原文只替换该印象，立即撤下画像且不新增模型调用', async t => {
  const h = await fixture(t);
  const st = seed(h);
  const response = await h.append('本人明确表示是真的疲惫', '他总是逞强');
  assert.equal(response.status, 200);
  assert.deepEqual(plain(st.memberImpressions[target].traits), ['喜欢清淡食物', '本人明确表示是真的疲惫']);
  const profile = h.longMemoryState.store.profiles[key];
  assert.equal(profile.text, '');
  assert.equal(profile.turns, 3, '保留既有刷新计数');
  assert.deepEqual(plain(profile.corrections), [{ target, oldContent: '他总是逞强', content: '本人明确表示是真的疲惫' }]);
  assert.equal(h.calls.prompts.length, 0);
  assert.doesNotMatch(h.buildWakePromptV2(key, 'question'), /OLD_PROFILE_MARKER/);
  assert.match(h.buildWakePromptV2(key, 'question'), /已.*纠正|更正|撤回/);
  const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/long-memory.json'), 'utf8'));
  assert.deepEqual(stored.profiles[key], plain(profile));
});

test('不存在的旧原文返回404，非法参数返回400，均不修改印象与画像', async t => {
  const h = await fixture(t);
  const st = seed(h);
  const before = JSON.stringify({ impressions: st.memberImpressions, profile: h.longMemoryState.store.profiles[key] });
  assert.equal((await h.append('新事实', '不存在的旧原文')).status, 404);
  for (const invalid of ['', null, 42]) assert.equal((await h.append('新事实', invalid)).status, 400);
  assert.equal(JSON.stringify({ impressions: st.memberImpressions, profile: h.longMemoryState.store.profiles[key] }), before);
  assert.equal(h.calls.prompts.length, 0);
});

test('纠正不存在的会话不会先创建空状态', async t => {
  const h = await fixture(t);
  const before = h.socialV2.conversations.size;
  const response = await h.append('新事实', '不存在');
  assert.equal(response.status, 404);
  assert.equal(h.socialV2.conversations.size, before);
});

test('原文相同的纠正不撤下画像，普通追加保留原刷新流程', async t => {
  const h = await fixture(t);
  seed(h);
  const before = plain(h.longMemoryState.store.profiles[key]);
  assert.equal((await h.append('他总是逞强', '他总是逞强')).status, 200);
  assert.deepEqual(plain(h.longMemoryState.store.profiles[key]), before);
  await h.append('喜欢散步');
  assert.deepEqual(plain(h.longMemoryState.store.profiles[key]), before);
});

for (const [route, body] of [
  ['memory-update', { category: 'memberImpression', target, newContent: '本人表示真的疲惫,喜欢清淡食物' }],
  ['memory-remove', { category: 'memberImpression', target }],
  ['memory-clear', { category: 'memberImpression' }],
  ['memory-clear', {}],
]) {
  test(`${route} 成功修改印象后同步撤下画像，保留长期摘要和RAW`, async t => {
    const h = await fixture(t);
    seed(h);
    h.appendSocialV2Message(key, target, '原始记录', '原始记录', false, true, 1, [], '123');
    const rawBefore = plain(h.memoryJournal.pending(key));
    h.longMemoryState.store.conversations[key] = [{ summary: '保留原摘要', t: '2026-01-01' }];
    assert.equal((await h.post(route, body)).status, 200);
    assert.equal(h.longMemoryState.store.profiles[key].text, '');
    assert.ok(h.longMemoryState.store.profiles[key].corrections.length);
    assert.deepEqual(plain(h.memoryJournal.pending(key)), rawBefore);
    assert.equal(h.longMemoryState.store.conversations[key][0].summary, '保留原摘要');
  });
}

test('话题操作和未命中的删除不改变画像', async t => {
  const h = await fixture(t);
  seed(h);
  const before = plain(h.longMemoryState.store.profiles[key]);
  await h.post('memory-clear', { category: 'activeTopic' });
  await h.post('memory-remove', { category: 'memberImpression', target: '不存在的人' });
  assert.deepEqual(plain(h.longMemoryState.store.profiles[key]), before);
});

test('纠正按既有计数刷新，纠正材料在刷新及重载后仍保留', async t => {
  const h = await fixture(t);
  seed(h);
  await h.append('本人明确表示是真的疲惫', '他总是逞强');
  modelReply(h, '本人会直接说明当前身体感受');
  h.maybeRefreshProfile(key); await h.flushMemoryTasks();
  assert.equal(h.calls.prompts.length, 0);
  h.maybeRefreshProfile(key); await h.flushMemoryTasks();
  assert.equal(h.calls.prompts.length, 1);
  const sent = h.calls.prompts[0].content[0].text;
  assert.match(sent, /本人明确表示是真的疲惫/);
  assert.match(sent, /他总是逞强/);
  assert.doesNotMatch(sent, /OLD_PROFILE_MARKER/);
  assert.ok(h.longMemoryState.store.profiles[key].corrections.length);
  const saved = fs.readFileSync(path.join(h.temp, 'state/long-memory.json'), 'utf8');
  const restarted = await fixture(t, { files: { 'state/long-memory.json': saved } });
  assert.deepEqual(plain(restarted.longMemoryState.store.profiles[key].corrections), plain(h.longMemoryState.store.profiles[key].corrections));
});

test('纠正期间在途旧画像不能写回，后续刷新采用纠正后的材料', async t => {
  const h = await fixture(t);
  seed(h);
  let session;
  h.api.sessions.prompt = async params => { h.calls.prompts.push(params); session = params.sessionId; return { result: { ok: true } }; };
  const pending = h.refreshProfile(key, 'OLD_PROFILE_MARKER', [], [{ target, content: '他总是逞强' }]);
  const deadline = Date.now() + 2000;
  while (!h.learnerWaiters.get(session)?.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(h.learnerWaiters.get(session)?.length);
  await h.append('本人明确表示是真的疲惫', '他总是逞强');
  for (const waiter of h.learnerWaiters.get(session)) { clearTimeout(waiter.timer); waiter.resolve('STALE_PROFILE_RESULT'); }
  h.learnerWaiters.delete(session);
  await pending;
  assert.equal(h.longMemoryState.store.profiles[key].text, '');
  assert.doesNotMatch(h.buildWakePromptV2(key, 'question'), /STALE_PROFILE_RESULT/);
});

test('纠正画像写盘失败明确报错，不伪装成持久化成功', async t => {
  const h = await fixture(t, { globals: { saveLongMemoryStore: () => { throw new Error('fixture write denied'); } } });
  seed(h);
  const response = await h.append('本人表示是真的疲惫', '他总是逞强');
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /画像纠正.*持久化|持久化.*画像纠正/);
  assert.equal(h.longMemoryState.store.profiles[key].text, '', '当前进程不能继续注入旧画像');
});

test('超过十条的既有印象精确纠正时不裁剪其他条目，连续纠正保留撤回链', async t => {
  const h = await fixture(t);
  seed(h, Array.from({ length: 15 }, (_, i) => `已有事实${i}`));
  await h.append('修正一', '已有事实5');
  await h.append('修正二', '修正一');
  assert.equal(h.getSocialV2State(key).memberImpressions[target].traits.length, 15);
  assert.ok(h.getSocialV2State(key).memberImpressions[target].traits.includes('已有事实0'));
  const corrections = plain(h.longMemoryState.store.profiles[key].corrections);
  assert.deepEqual(corrections.map(item => item.oldContent), ['已有事实5', '修正一']);
});

test('画像任务排队后被纠正，开始时不再请求过时材料', async t => {
  const h = await fixture(t);
  seed(h);
  h.longMemoryState.store.profiles[key].turns = 4;
  // 与生产排队同样先捕获原对象；纠正已换对象后再执行捕获的任务。
  const old = h.longMemoryState.store.profiles[key];
  const epoch = h.memoryJournal.epoch(key);
  await h.append('本人表示是真的疲惫', '他总是逞强');
  await h.refreshProfile(key, old.text, [], [{ target, content: '他总是逞强' }], epoch, old);
  assert.equal(h.calls.prompts.length, 0);
});

test('实际MCP工具参数解析到HTTP写入再到唤醒提示，oldContent不被schema丢弃', async t => {
  const h = await fixture(t);
  const st = seed(h);
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  const start = source.indexOf("server.tool(\n  'qq_memory_append',");
  const end = source.indexOf("server.tool(\n  'qq_memory_query',", start);
  assert.ok(start >= 0 && end > start);
  let registered;
  const context = vm.createContext({
    z, server: { tool: (name, description, schema, handler) => { registered = { name, schema, handler }; } },
    serializeModelData: JSON.stringify,
    agentApi: async (route, options) => {
      assert.equal(route, '/api/socialV2/memory-append');
      const response = await h.post('memory-append', JSON.parse(options.body));
      if (response.status !== 200) throw new Error(response.body.error);
      return response.body;
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const parameters = z.object(registered.schema).parse({ key, token: st.agentToken, category: 'memberImpression',
    content: '本人明确说身体疲惫', extra: { target, oldContent: '他总是逞强' } });
  const result = await registered.handler(parameters);
  assert.notEqual(result.isError, true);
  assert.deepEqual(plain(st.memberImpressions[target].traits), ['喜欢清淡食物', '本人明确说身体疲惫']);
  const wake = h.buildWakePromptV2(key, 'question');
  assert.doesNotMatch(wake, /OLD_PROFILE_MARKER/);
  assert.match(wake, /本人明确说身体疲惫/);
});

test('轻量状态写盘失败返回部分失败，当前进程仍撤下旧画像', async t => {
  let fail = false;
  const h = await fixture(t, { globals: { fs: { ...fs, renameSync: (source, destination) => {
    if (fail && path.basename(destination) === 'social-v2.json') throw new Error('fixture social write denied');
    return fs.renameSync(source, destination);
  } } } });
  seed(h);
  fail = true;
  const response = await h.append('本人明确说明身体疲惫', '他总是逞强');
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /轻量.*持久化/);
  assert.equal(h.longMemoryState.store.profiles[key].text, '');
});

test('会话编号前导零归一后撤下同一份画像，不创建另一份画像', async t => {
  const h = await fixture(t);
  seed(h);
  const response = await h.post('memory-append', { key: 'private:00123', category: 'memberImpression',
    content: '本人表示是真的疲惫', extra: { target, oldContent: '他总是逞强' } });
  assert.equal(response.status, 200);
  assert.equal(h.longMemoryState.store.profiles[key].text, '');
  assert.equal(h.longMemoryState.store.profiles['private:00123'], undefined);
});
