import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSummaryTranscriptBatch } from '../src/memory-transcript.js';

test('普通批次保留消息对象，并沿用角色、发送者和空白格式', () => {
  const messages = [
    { sourceId: 'a', role: 'user', sender: ' 私聊 ', text: '  我喜欢\n 乌龙茶 ' },
    { sourceId: 'b', role: 'assistant', sender: '助手', text: ' 好的\t记住了 ' },
    { sourceId: 'c', role: 'user', sender: ' 小王 ', plain: '收到' },
  ];
  const batch = buildSummaryTranscriptBatch(messages);
  assert.deepEqual(batch.messages, messages);
  assert.equal(batch.messages[0], messages[0]);
  assert.equal(batch.transcript, '你: 我喜欢 乌龙茶\n她: 好的 记住了\n对方(小王): 收到');
  assert.equal(messages[1].isSelf, undefined);
});

test('字符边界只取连续前缀，不切断第二条也不跳到更短的第三条', () => {
  const messages = [
    { sourceId: 'a', role: 'user', text: '1234' },
    { sourceId: 'b', role: 'user', text: '5678' },
    { sourceId: 'c', role: 'user', text: '9' },
  ];
  const batch = buildSummaryTranscriptBatch(messages, { maxChars: 14 });
  assert.deepEqual(batch.messages.map((m) => m.sourceId), ['a']);
  assert.equal(batch.transcript, '你: 1234');
  const exact = buildSummaryTranscriptBatch(messages, { maxChars: 15 });
  assert.deepEqual(exact.messages.map((m) => m.sourceId), ['a', 'b']);
  assert.equal(exact.transcript, '你: 1234\n你: 5678');
});

test('超长首条完整独占一批，后续消息继续待处理', () => {
  const text = `完整开头${'长'.repeat(4500)}完整结尾`;
  const messages = [
    { sourceId: 'long', role: 'assistant', text },
    { sourceId: 'next', role: 'user', text: '下一条' },
  ];
  const batch = buildSummaryTranscriptBatch(messages);
  assert.deepEqual(batch.messages.map((m) => m.sourceId), ['long']);
  assert.equal(batch.transcript, `她: ${text}`);
  assert.equal(messages[1].sourceId, 'next');
});

test('空白前缀与首个超长正文一同入批，避免空转阻塞正文', () => {
  const text = `完整开头${'长'.repeat(4500)}完整结尾`;
  const messages = [
    { sourceId: 'blank', role: 'user', text: ' \n\t ' },
    { sourceId: 'long', role: 'user', text },
    { sourceId: 'later', role: 'user', text: '后续' },
  ];
  const batch = buildSummaryTranscriptBatch(messages, { limit: 2 });
  assert.deepEqual(batch.messages.map((m) => m.sourceId), ['blank', 'long']);
  assert.equal(batch.transcript, `你: ${text}`);
  assert.deepEqual(messages.slice(batch.messages.length).map((m) => m.sourceId), ['later']);
});

test('全空白前缀超过limit时仍只取原条数上限，不跨批寻找正文', () => {
  const messages = [
    { sourceId: 'blank-1', text: ' ' },
    { sourceId: 'blank-2', text: '\t' },
    { sourceId: 'blank-3', text: '\n' },
    { sourceId: 'long', role: 'user', text: '长'.repeat(4500) },
  ];
  const batch = buildSummaryTranscriptBatch(messages, { limit: 2 });
  assert.deepEqual(batch.messages.map((m) => m.sourceId), ['blank-1', 'blank-2']);
  assert.equal(batch.transcript, '');
  assert.deepEqual(messages.slice(batch.messages.length).map((m) => m.sourceId), ['blank-3', 'long']);
});

test('默认4000字符预算不会丢掉第一条纠正，未入批的来源仍在尾部', () => {
  const correction = { sourceId: 'correction', role: 'user', text: '纠正一下，我不喝咖啡，只喝乌龙茶。' };
  const messages = [correction, ...Array.from({ length: 39 }, (_, i) => ({
    sourceId: `later-${i}`, role: 'user', text: `消息${i} ${'后续'.repeat(100)}`,
  }))];
  const batch = buildSummaryTranscriptBatch(messages);
  assert.equal(batch.messages[0], correction);
  assert.ok(batch.transcript.startsWith(`你: ${correction.text}\n`));
  assert.ok(batch.transcript.length <= 4000);
  assert.ok(batch.messages.length > 1 && batch.messages.length < messages.length);
  assert.deepEqual(batch.messages, messages.slice(0, batch.messages.length));
  assert.ok(batch.transcript.endsWith(batch.messages.at(-1).text));
  assert.equal(messages.length, 40);
});

test('空白消息保留来源ID，超预算消息及其后的空白不提前消费', () => {
  const messages = [
    { sourceId: 'blank-first', role: 'user', text: ' \n\t ' },
    { sourceId: 'first', role: 'user', text: '甲' },
    { sourceId: 'blank-middle', role: 'assistant', text: '' },
    { sourceId: 'later', role: 'user', text: '乙' },
    { sourceId: 'blank-later', role: 'user', text: ' ' },
  ];
  const batch = buildSummaryTranscriptBatch(messages, { maxChars: 4 });
  assert.deepEqual(batch.messages.map((m) => m.sourceId), ['blank-first', 'first', 'blank-middle']);
  assert.equal(batch.transcript, '你: 甲');
  assert.deepEqual(messages.slice(batch.messages.length).map((m) => m.sourceId), ['later', 'blank-later']);
});

test('全空白批次仍保留连续前缀来源，空输入返回空批次', () => {
  const messages = [
    { sourceId: 'a', text: ' ' },
    { sourceId: 'b', text: '\t' },
    { sourceId: 'c', text: '' },
  ];
  assert.deepEqual(buildSummaryTranscriptBatch(messages, { limit: 2 }), {
    messages: messages.slice(0, 2), transcript: '',
  });
  assert.deepEqual(buildSummaryTranscriptBatch([]), { messages: [], transcript: '' });
});

test('默认最多40条，合法自定义limit只限制最早前缀条数', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ sourceId: String(i), text: `消息${i}` }));
  const defaultBatch = buildSummaryTranscriptBatch(messages);
  assert.equal(defaultBatch.messages.length, 40);
  assert.equal(defaultBatch.messages[0].sourceId, '0');
  assert.equal(defaultBatch.messages.at(-1).sourceId, '39');
  for (const limit of [1, 2, 5, 45, 50]) {
    const batch = buildSummaryTranscriptBatch(messages, { limit });
    assert.deepEqual(batch.messages, messages.slice(0, limit));
  }
});
