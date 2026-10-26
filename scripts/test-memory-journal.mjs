import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryJournal } from '../src/memory-journal.js';

const KEY = 'group:456';
const OTHER = 'private:789';

function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'qq-memory-journal-'));
  const file = path.join(dir, 'memory.sqlite');
  const opened = new Set();
  const open = () => {
    const journal = new MemoryJournal(file);
    opened.add(journal);
    return journal;
  };
  t.after(() => {
    for (const journal of opened) journal.close();
    assert.equal(path.dirname(path.resolve(dir)), root);
    assert.ok(path.basename(dir).startsWith('qq-memory-journal-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, open, journal: open() };
}

function raw(journal, key = KEY, n = 1, extra = {}) {
  return journal.appendRaw(key, {
    role: 'user', sender: '测试成员', userId: '1001', text: `原始消息${n}`,
    time: '2026-10-23T12:00:00+08:00', messageId: `${n}`, ...extra
  });
}

function commit(journal, records, memories, key = KEY, extra = {}) {
  const state = journal.checkpoint(key);
  return journal.commitExtraction(key, {
    expectedCheckpoint: state.checkpoint, expectedEpoch: state.epoch,
    sourceIds: records.map((record) => record.id), memories,
    time: '2026-10-23T12:01:00+08:00', ...extra
  });
}

test('RAW 全文不变，按 key/messageId 去重，缺 messageId 的独立消息使用不同 ID', (t) => {
  const { journal } = fixture(t);
  const text = `  多行原文\n${'长文本🙂'.repeat(3000)}\t结束  `;
  const first = raw(journal, KEY, 1, { text });
  const repeated = raw(journal, KEY, 1, { text: '重复投递不能覆盖最初原文' });
  assert.deepEqual(repeated, first);
  assert.equal(first.text, text);
  assert.equal(first.key, KEY);
  assert.equal(first.sender, '测试成员');
  assert.equal(first.userId, '1001');
  assert.equal(first.role, 'user');
  assert.equal(first.messageId, '1');
  assert.equal(first.time, '2026-10-23T12:00:00+08:00');
  assert.ok(Number.isSafeInteger(first.seq) && first.seq > 0);
  const noId1 = raw(journal, KEY, 2, { messageId: undefined });
  const noId2 = raw(journal, KEY, 2, { messageId: undefined });
  assert.notEqual(noId1.id, noId2.id);
  assert.ok(noId2.seq > noId1.seq && noId1.seq > first.seq);
  assert.deepEqual(journal.pending(KEY), [first, noId1, noId2]);
});

for (const count of [0, 1, 3]) {
  test(`一次事务提交 ${count} 条规范结果后才推进 checkpoint，并保留 provenance/version`, (t) => {
    const { journal, file } = fixture(t);
    const records = [raw(journal, KEY, 1), raw(journal, KEY, 2)];
    assert.deepEqual(journal.checkpoint(KEY), { checkpoint: 0, epoch: 0 });
    const memories = Array.from({ length: count }, (_, i) => ({ summary: `长期摘要${i}`, tags: [`标签${i}`] }));
    const result = commit(journal, records, memories);
    assert.equal(result.checkpoint, records[1].seq);
    assert.equal(result.epoch, 0);
    assert.equal(result.entries.length, count);
    assert.deepEqual(journal.entries(KEY), result.entries);
    for (let i = 0; i < count; i++) {
      const entry = result.entries[i];
      assert.equal(entry.summary, memories[i].summary);
      assert.deepEqual(entry.tags, memories[i].tags);
      assert.equal(entry.type, 'summary');
      assert.equal(entry.schemaVersion, 1);
      assert.equal(entry.sourceKind, 'conversation');
      assert.deepEqual(entry.sourceIds, records.map((record) => record.id));
      assert.equal(entry.key, KEY);
      assert.equal(entry.epoch, 0);
      assert.equal(entry.time, '2026-10-23T12:01:00+08:00');
      assert.ok(entry.id);
    }
    assert.deepEqual(journal.pending(KEY), []);
    const db = new DatabaseSync(file);
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages').get().n, 2, '处理完成不能删除 RAW'); }
    finally { db.close(); }
  });
}

test('中途写入失败回滚所有条目和 checkpoint，原批次仍可重试', (t) => {
  const { journal, file } = fixture(t);
  const records = [raw(journal, KEY, 1), raw(journal, KEY, 2)];
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TRIGGER fixture_failure BEFORE INSERT ON memories
      WHEN NEW.summary = '触发失败' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;`);
    assert.throws(() => commit(journal, records, [
      { summary: '第一条已进入事务', tags: [] }, { summary: '触发失败', tags: [] }
    ]), /fixture insert failure/);
    assert.deepEqual(journal.checkpoint(KEY), { checkpoint: 0, epoch: 0 });
    assert.deepEqual(journal.entries(KEY), []);
    assert.deepEqual(journal.pending(KEY), records);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM extractions').get().n, 0);
    db.exec('DROP TRIGGER fixture_failure');
    assert.equal(commit(journal, records, [{ summary: '重试成功', tags: [] }]).entries.length, 1);
  } finally { db.close(); }
});

test('重启后同一批结果重试不重复，durable seq 不随旧会话轮换归零', (t) => {
  const { journal, open } = fixture(t);
  const first = raw(journal, KEY, 1);
  const state = journal.checkpoint(KEY);
  const input = {
    expectedCheckpoint: state.checkpoint, expectedEpoch: state.epoch,
    sourceIds: [first.id], memories: [{ summary: '已成功写入', tags: ['事实'] }], time: '2026-10-23'
  };
  const result = journal.commitExtraction(KEY, input);
  journal.close();
  const restarted = open();
  assert.deepEqual(restarted.commitExtraction(KEY, input), result);
  assert.equal(restarted.entries(KEY).length, 1);
  assert.deepEqual(raw(restarted, KEY, 1), first);
  const second = raw(restarted, KEY, 2, { seq: 1 });
  assert.ok(second.seq > first.seq);
  assert.deepEqual(restarted.pending(KEY), [second]);
});

test('合法空结果批次在重启后重试仍幂等', (t) => {
  const { journal, open } = fixture(t);
  const first = raw(journal);
  const input = { expectedCheckpoint: 0, expectedEpoch: 0, sourceIds: [first.id], memories: [], time: '2026-10-23' };
  const result = journal.commitExtraction(KEY, input);
  journal.close();
  assert.deepEqual(open().commitExtraction(KEY, input), result);
});

test('不同 QQ key 的相同 messageId、RAW、条目与 checkpoint 相互隔离', (t) => {
  const { journal } = fixture(t);
  const a = raw(journal, KEY, 1);
  const b = raw(journal, OTHER, 1);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(journal.pending(KEY), [a]);
  assert.deepEqual(journal.pending(OTHER), [b]);
  commit(journal, [a], [{ summary: '群内摘要', tags: [] }]);
  assert.equal(journal.entries(KEY).length, 1);
  assert.deepEqual(journal.entries(OTHER), []);
  assert.deepEqual(journal.checkpoint(OTHER), { checkpoint: 0, epoch: 0 });
});

test('pending 从最早未处理消息读取且最多 40 条，不能跳过缺口或跨 key 提交', (t) => {
  const { journal } = fixture(t);
  const records = Array.from({ length: 45 }, (_, i) => raw(journal, KEY, i + 1));
  const foreign = raw(journal, OTHER, 1);
  assert.deepEqual(journal.pending(KEY, { limit: 1000 }), records.slice(0, 40));
  assert.deepEqual(journal.pending(KEY, { limit: 2 }), records.slice(0, 2));
  for (const invalid of [[records[1]], [records[0], records[2]], [records[1], records[0]], [records[0], records[0]], [foreign]]) {
    assert.throws(() => commit(journal, invalid, []), /source|来源|连续|顺序|重复/);
    assert.deepEqual(journal.checkpoint(KEY), { checkpoint: 0, epoch: 0 });
  }
  assert.throws(() => commit(journal, [{ id: '不存在' }], []), /source|来源/);
  commit(journal, records.slice(0, 40), []);
  assert.deepEqual(journal.pending(KEY), records.slice(40));
});

test('pendingCount 超过 40 条仍按角色计数，空白保留 RAW 但不计触发阈值', (t) => {
  const { journal } = fixture(t);
  const users = Array.from({ length: 45 }, (_, i) => raw(journal, KEY, i + 1));
  for (let i = 0; i < 7; i++) raw(journal, KEY, 101 + i, { role: 'assistant' });
  const blankTexts = ['', ' ', '\t\r\n', '　', '\u00a0\ufeff'];
  const blanks = blankTexts.map((text, i) => raw(journal, KEY, 201 + i, { text }));
  for (let i = 0; i < 3; i++) raw(journal, OTHER, i + 1);
  assert.equal(journal.pending(KEY).length, 40);
  assert.equal(journal.pendingCount(KEY, { role: 'user' }), 45);
  assert.equal(journal.pendingCount(KEY, { role: 'assistant' }), 7);
  assert.equal(journal.pendingCount(KEY), 52);
  assert.equal(journal.pendingCount(OTHER, { role: 'user' }), 3);
  commit(journal, users.slice(0, 40), []);
  assert.equal(journal.pendingCount(KEY, { role: 'user' }), 5);
  assert.equal(journal.pendingCount(KEY, { role: 'assistant' }), 7);
  assert.equal(journal.pendingCount(KEY), 12);
  assert.deepEqual(journal.pending(KEY).slice(-blanks.length), blanks);
  commit(journal, journal.pending(KEY), []);
  assert.equal(journal.pendingCount(KEY), 0);
  assert.equal(journal.pendingCount(OTHER), 3);
});

test('pendingCount 只读未知 key，拒绝非法角色，遗忘后从新 epoch 计数', (t) => {
  const { journal, file } = fixture(t);
  assert.equal(journal.pendingCount(KEY), 0);
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversation_state').get().n, 0); }
  finally { db.close(); }
  assert.throws(() => journal.pendingCount(KEY, { role: 'tool' }), /role/);
  assert.throws(() => journal.pendingCount('../invalid'), /key/);
  raw(journal);
  assert.equal(journal.pendingCount(KEY, { role: 'user' }), 1);
  journal.forget(KEY);
  assert.equal(journal.pendingCount(KEY), 0);
  raw(journal, KEY, 1, { role: 'assistant' });
  assert.equal(journal.pendingCount(KEY, { role: 'user' }), 0);
  assert.equal(journal.pendingCount(KEY, { role: 'assistant' }), 1);
});

test('非法规范结果与过期 checkpoint 不推进处理位置', (t) => {
  const { journal } = fixture(t);
  const records = [raw(journal)];
  for (const invalid of [null, {}, [{}], [{ summary: '', tags: [] }], [{ summary: '内容', tags: '非法标签' }]]) {
    assert.throws(() => commit(journal, records, invalid), /memor|summary|tags|结果|摘要|标签/);
    assert.equal(journal.checkpoint(KEY).checkpoint, 0);
  }
  assert.throws(() => commit(journal, records, [], KEY, { expectedCheckpoint: 9 }), /checkpoint/);
  assert.throws(() => commit(journal, records, [], KEY, { expectedEpoch: undefined }), /epoch|Epoch/);
  assert.deepEqual(journal.pending(KEY), records);
});

test('forget 清除指定 key 的 RAW/条目/批次与 checkpoint，旧 epoch 在途结果不能复活', (t) => {
  const { journal, file, open } = fixture(t);
  const old = raw(journal, KEY, 1);
  const other = raw(journal, OTHER, 1);
  commit(journal, [old], [{ summary: '待遗忘的摘要', tags: [] }]);
  const inFlight = raw(journal, KEY, 2);
  const oldState = journal.checkpoint(KEY);
  journal.forget(KEY);
  assert.deepEqual(journal.checkpoint(KEY), { checkpoint: 0, epoch: 1 });
  assert.equal(journal.epoch(KEY), 1);
  assert.deepEqual(journal.pending(KEY), []);
  assert.deepEqual(journal.entries(KEY), []);
  assert.deepEqual(journal.pending(OTHER), [other]);
  const db = new DatabaseSync(file);
  try {
    for (const table of ['raw_messages', 'memories', 'extractions']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_key = ?`).get(KEY).n, 0);
    }
  } finally { db.close(); }
  const fresh = raw(journal, KEY, 2);
  assert.ok(fresh.seq > inFlight.seq);
  assert.throws(() => journal.commitExtraction(KEY, {
    expectedCheckpoint: oldState.checkpoint, expectedEpoch: oldState.epoch,
    sourceIds: [inFlight.id], memories: [{ summary: '不能复活', tags: [] }], time: '2026-10-23'
  }), /epoch|Epoch/);
  assert.deepEqual(journal.entries(KEY), []);
  assert.deepEqual(journal.pending(KEY), [fresh]);
  journal.close();
  assert.deepEqual(open().checkpoint(KEY), { checkpoint: 0, epoch: 1 });
});

test('entries limit 返回最近若干条并保持顺序，不删除更早数据', (t) => {
  const { journal } = fixture(t);
  for (let i = 1; i <= 3; i++) commit(journal, [raw(journal, KEY, i)], [{ summary: `摘要${i}`, tags: [] }]);
  assert.deepEqual(journal.entries(KEY, { limit: 2 }).map((entry) => entry.summary), ['摘要2', '摘要3']);
  assert.equal(journal.entries(KEY, { limit: 500 }).length, 3);
});

test('entriesAfter 用 durable seq 分页整个历史，跨 key 间隙不串数据且不遗漏', (t) => {
  const { journal, open } = fixture(t);
  for (let i = 1; i <= 5; i++) {
    commit(journal, [raw(journal, KEY, i)], [{ summary: `本会话${i}`, tags: [] }]);
    commit(journal, [raw(journal, OTHER, i)], [{ summary: `其他会话${i}`, tags: [] }], OTHER);
  }
  assert.equal(typeof journal.entriesAfter, 'function');
  const all = journal.entries(KEY);
  assert.ok(all.every((entry) => Number.isSafeInteger(entry.seq) && entry.seq > 0));
  const page1 = journal.entriesAfter(KEY, { after: 0, limit: 2 });
  const page2 = journal.entriesAfter(KEY, { after: page1.at(-1).seq, limit: 2 });
  const page3 = journal.entriesAfter(KEY, { after: page2.at(-1).seq, limit: 2 });
  assert.deepEqual([...page1, ...page2, ...page3], all);
  assert.deepEqual(journal.entriesAfter(KEY, { after: page3.at(-1).seq }), []);
  assert.deepEqual(journal.entriesAfter(OTHER, { limit: 1 }), journal.entries(OTHER).slice(0, 1));
  journal.close();
  assert.deepEqual(open().entriesAfter(KEY, { after: page1.at(-1).seq, limit: 2 }), page2);
});

test('entriesAfter 每页最多 100 条并从最早历史开始，不受 entries 最近条数影响', (t) => {
  const { journal } = fixture(t);
  for (let i = 0; i < 35; i++) {
    commit(journal, [raw(journal, KEY, i + 1)], Array.from({ length: 3 }, (_, j) => ({ summary: `摘要${i * 3 + j}`, tags: [] })));
  }
  assert.equal(typeof journal.entriesAfter, 'function');
  const first = journal.entriesAfter(KEY, { limit: 1000 });
  assert.equal(first.length, 100);
  assert.equal(first[0].summary, '摘要0');
  assert.equal(first[99].summary, '摘要99');
  assert.deepEqual(journal.entriesAfter(KEY, { after: first.at(-1).seq }).map((entry) => entry.summary),
    ['摘要100', '摘要101', '摘要102', '摘要103', '摘要104']);
});
