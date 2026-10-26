import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'private:123';
async function fixture(t) {
  const h = await bridgeHarness({ config: { socialV2: { longMemory: {
    summarizeEveryMessages: 2, profileEnabled: false, digestEnabled: false,
  } } } });
  t.after(() => h.close());
  h.setMode('reserved2');
  h.incoming = (id, text) => h.appendSocialV2Message(key, '测试用户', text, text, false, true, id, [], '123');
  h.respond = reply => {
    h.api.sessions.prompt = async params => {
      h.calls.prompts.push(params);
      setTimeout(() => {
        for (const waiter of h.learnerWaiters.get(params.sessionId) ?? []) { clearTimeout(waiter.timer); waiter.resolve(reply); }
        h.learnerWaiters.delete(params.sessionId);
      }, 1);
      return { result: { ok: true } };
    };
  };
  h.run = async () => { h.longMemoryState.lastAt.clear(); h.maybeSummarizeLongMemory(key); await h.flushMemoryTasks(); };
  return h;
}

test('从真实入站到摘要提交只消费完整呈现的前缀，首条纠正和未处理尾部均保留', async t => {
  const h = await fixture(t);
  const texts = ['我说的是真的累，不是在逞强', ...Array.from({ length: 7 }, (_, i) => `消息${i + 2}正文` + '材料'.repeat(400) + `消息${i + 2}末尾`)];
  texts.forEach((text, i) => h.incoming(i + 1, text));
  const all = h.memoryJournal.pending(key);
  h.respond('{"memories":[{"summary":"本人明确否认逞强，表示是真的累","tags":[]}]}');
  await h.run();
  assert.equal(h.calls.prompts.length, 1, '一次触发仍只调用一次模型');
  const prompt = h.calls.prompts[0].content[0].text;
  assert.ok(prompt.includes(texts[0]), '最早的纠正不能被截掉');
  const sources = h.memoryJournal.entries(key)[0].sourceIds;
  assert.ok(sources.length < all.length, '未呈现的尾部必须仍待处理');
  for (const source of all.filter(row => sources.includes(row.id))) assert.ok(prompt.includes(source.text), '每个已提交来源必须全文呈现');
  const remaining = h.memoryJournal.pending(key);
  assert.equal(remaining.length, all.length - sources.length);
  assert.equal(remaining[0].id, all[sources.length].id);
  h.respond('{"memories":[]}');
  await h.run();
  assert.equal(h.calls.prompts.length, 2);
  assert.equal(h.memoryJournal.pendingCount(key), 0);
  for (const source of remaining) assert.ok(h.calls.prompts[1].content[0].text.includes(source.text));
});

test('超长单条全文交给模型，后续消息不被提前标记为已处理', async t => {
  const h = await fixture(t);
  const long = '开头的纠正' + '长内容'.repeat(1600) + '最后也要保留';
  h.incoming(1, long); h.incoming(2, '下一条消息');
  h.respond('{"memories":[]}');
  await h.run();
  assert.ok(h.calls.prompts[0].content[0].text.includes(long));
  assert.equal(h.memoryJournal.pending(key).length, 1);
  assert.equal(h.memoryJournal.pending(key)[0].messageId, '2');
  assert.equal(h.memoryJournal.checkpoint(key).checkpoint, 1);
});

test('空白前缀加超长正文不阻塞，模型失败不推进任何来源', async t => {
  const h = await fixture(t);
  const long = '完整长消息'.repeat(1100);
  h.incoming(1, '  '); h.incoming(2, long); h.incoming(3, '尚未处理的尾部');
  h.respond('invalid JSON');
  await h.run();
  assert.ok(h.calls.prompts[0].content[0].text.includes(long));
  assert.equal(h.memoryJournal.checkpoint(key).checkpoint, 0);
  assert.equal(h.memoryJournal.pending(key).length, 3);
  h.respond('{"memories":[]}');
  await h.run();
  assert.equal(h.memoryJournal.checkpoint(key).checkpoint, 2);
  assert.equal(h.memoryJournal.pending(key)[0].messageId, '3');
});
