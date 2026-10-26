// RAW、规范摘要和处理水位在同一个 SQLite 中保存；处理成功不会删除 RAW。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
// SQLite trim(X, chars) 使用字符集合；与 JS String.trim 的空白范围保持一致。
const TEXT_WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function checkKey(key) {
  if (typeof key !== 'string' || !/^(group|private):[1-9]\d*$/.test(key)) throw new TypeError('Invalid conversation key');
  return key;
}

function checkInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${name}`);
}

function checkTime(time) {
  if ((typeof time === 'string' && time.length > 0) || (typeof time === 'number' && Number.isFinite(time))) return;
  throw new TypeError('Invalid time');
}

function rawRecord(row) {
  return { ...JSON.parse(row.payload), id: row.id, seq: row.seq, key: row.conversation_key, epoch: row.epoch };
}

function memoryRecord(row) {
  return {
    id: row.id, seq: row.seq, key: row.conversation_key, epoch: row.epoch,
    type: 'summary', schemaVersion: row.schema_version, sourceKind: 'conversation',
    sourceIds: JSON.parse(row.source_ids), summary: row.summary, tags: JSON.parse(row.tags),
    time: JSON.parse(row.time)
  };
}

export class MemoryJournal {
  #db;
  #closed = false;

  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    try {
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Unsupported memory journal schema version: ${version}`);
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_state (
          conversation_key TEXT PRIMARY KEY, checkpoint INTEGER NOT NULL DEFAULT 0,
          epoch INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS raw_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          conversation_key TEXT NOT NULL, epoch INTEGER NOT NULL,
          message_id TEXT, payload TEXT NOT NULL,
          UNIQUE (conversation_key, epoch, message_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS raw_conversation_seq ON raw_messages(conversation_key, seq);
        CREATE TABLE IF NOT EXISTS extractions (
          id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, epoch INTEGER NOT NULL,
          start_checkpoint INTEGER NOT NULL, end_seq INTEGER NOT NULL,
          source_ids TEXT NOT NULL, time TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS extraction_conversation ON extractions(conversation_key);
        CREATE TABLE IF NOT EXISTS memories (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          batch_id TEXT NOT NULL REFERENCES extractions(id), conversation_key TEXT NOT NULL,
          epoch INTEGER NOT NULL, schema_version INTEGER NOT NULL,
          source_ids TEXT NOT NULL, summary TEXT NOT NULL, tags TEXT NOT NULL, time TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memory_conversation_seq ON memories(conversation_key, seq);
        CREATE INDEX IF NOT EXISTS memory_batch ON memories(batch_id, seq);
        PRAGMA user_version = 1;
      `);
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  #transaction(run) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #ensureState(key) {
    this.#db.prepare('INSERT INTO conversation_state(conversation_key) VALUES (?) ON CONFLICT DO NOTHING').run(key);
    return this.checkpoint(key);
  }

  /** 未出现过的 key 读作 epoch=0、checkpoint=0；读取不创建 RAW 或条目。 */
  checkpoint(key) {
    checkKey(key);
    const row = this.#db.prepare('SELECT checkpoint, epoch FROM conversation_state WHERE conversation_key = ?').get(key);
    return row ? { checkpoint: row.checkpoint, epoch: row.epoch } : { checkpoint: 0, epoch: 0 };
  }

  epoch(key) {
    return this.checkpoint(key).epoch;
  }

  /** 返回持久化后的完整原文；QQ messageId 重投递返回最初记录，不覆盖正文。 */
  appendRaw(key, record) {
    checkKey(key);
    if (!record || typeof record.text !== 'string' || typeof record.role !== 'string') throw new TypeError('Invalid RAW text or role');
    checkTime(record.time);
    const messageId = record.messageId === undefined || record.messageId === null || record.messageId === ''
      ? null : String(record.messageId);
    const suppliedId = typeof record.id === 'string' && record.id.length ? record.id : null;
    const payload = {
      role: record.role, sender: String(record.sender ?? ''), userId: String(record.userId ?? ''),
      text: record.text, time: record.time,
      ...(messageId === null ? {} : { messageId })
    };
    return this.#transaction(() => {
      const { epoch } = this.#ensureState(key);
      const id = messageId !== null ? `raw-${digest([key, epoch, 'message', messageId])}`
        : suppliedId ? `raw-${digest([key, epoch, 'source', suppliedId])}` : `raw-${crypto.randomUUID()}`;
      this.#db.prepare(`INSERT INTO raw_messages(id, conversation_key, epoch, message_id, payload)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(id, key, epoch, messageId, JSON.stringify(payload));
      return rawRecord(this.#db.prepare('SELECT * FROM raw_messages WHERE id = ?').get(id));
    });
  }

  /** 严格从水位后的第一条开始；最多返回 40 条，不回读整个 RAW 历史。 */
  pending(key, { limit = 40 } = {}) {
    checkKey(key);
    checkInteger(limit, 'limit');
    if (limit === 0) return [];
    const { checkpoint } = this.checkpoint(key);
    return this.#db.prepare(`SELECT * FROM raw_messages
      WHERE conversation_key = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(key, checkpoint, Math.min(40, limit)).map(rawRecord);
  }

  /** SQL 统计水位后的非空文字消息；触发阈值不受 pending 的 40 条批次上限影响。 */
  pendingCount(key, { role } = {}) {
    checkKey(key);
    if (role !== undefined && role !== 'user' && role !== 'assistant') throw new TypeError('Invalid role');
    const roleFilter = role === undefined ? '' : "AND json_extract(payload, '$.role') = ?";
    const params = [key, key, TEXT_WHITESPACE];
    if (role !== undefined) params.push(role);
    return this.#db.prepare(`SELECT COUNT(*) AS count FROM raw_messages
      WHERE conversation_key = ?
        AND seq > COALESCE((SELECT checkpoint FROM conversation_state WHERE conversation_key = ?), 0)
        AND trim(json_extract(payload, '$.text'), ?) <> '' ${roleFilter}`).get(...params).count;
  }

  /**
   * 仅提交已解析的 memories 数组。expectedEpoch 必传；sourceIds 必须为当前 pending
   * 的连续有序前缀。写入摘要、空结果批次及推进水位是一次事务，异常直接交给调用方。
   */
  commitExtraction(key, { expectedCheckpoint, expectedEpoch, sourceIds, memories, time }) {
    checkKey(key);
    checkInteger(expectedEpoch, 'expectedEpoch');
    if (expectedCheckpoint !== undefined) checkInteger(expectedCheckpoint, 'expectedCheckpoint');
    checkTime(time);
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 40
      || sourceIds.some((id) => typeof id !== 'string' || !id) || new Set(sourceIds).size !== sourceIds.length) {
      throw new TypeError('Invalid sourceIds: expected 1–40 unique source IDs');
    }
    if (!Array.isArray(memories)) throw new TypeError('Invalid memories array');
    for (const memory of memories) {
      if (!memory || typeof memory.summary !== 'string' || !memory.summary.trim()) throw new TypeError('Invalid memory summary');
      if (!Array.isArray(memory.tags) || memory.tags.some((tag) => typeof tag !== 'string')) throw new TypeError('Invalid memory tags');
    }
    return this.#transaction(() => {
      const state = this.#ensureState(key);
      if (expectedEpoch !== state.epoch) throw new Error('Memory epoch changed; extraction belongs to a forgotten conversation');
      const batchId = `batch-${digest([key, state.epoch, sourceIds])}`;
      const existing = this.#db.prepare('SELECT id FROM extractions WHERE id = ?').get(batchId);
      if (existing) {
        const entries = this.#db.prepare('SELECT * FROM memories WHERE batch_id = ? ORDER BY seq').all(batchId).map(memoryRecord);
        return { entries, checkpoint: state.checkpoint, epoch: state.epoch };
      }
      if (expectedCheckpoint !== undefined && expectedCheckpoint !== state.checkpoint) throw new Error('Memory checkpoint changed');
      const sources = this.#db.prepare(`SELECT id, seq FROM raw_messages
        WHERE conversation_key = ? AND seq > ? ORDER BY seq LIMIT ?`).all(key, state.checkpoint, sourceIds.length);
      if (sources.length !== sourceIds.length || sources.some((source, i) => source.id !== sourceIds[i])) {
        throw new Error('Invalid sourceIds: sources must be the next consecutive ordered messages for this key');
      }
      const checkpoint = sources.at(-1).seq;
      const serializedSources = JSON.stringify(sourceIds);
      const serializedTime = JSON.stringify(time);
      this.#db.prepare(`INSERT INTO extractions(id, conversation_key, epoch, start_checkpoint, end_seq, source_ids, time)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(batchId, key, state.epoch, state.checkpoint, checkpoint, serializedSources, serializedTime);
      const insert = this.#db.prepare(`INSERT INTO memories
        (id, batch_id, conversation_key, epoch, schema_version, source_ids, summary, tags, time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i];
        insert.run(`memory-${digest([batchId, i])}`, batchId, key, state.epoch, SCHEMA_VERSION,
          serializedSources, memory.summary, JSON.stringify(memory.tags), serializedTime);
      }
      this.#db.prepare('UPDATE conversation_state SET checkpoint = ? WHERE conversation_key = ?').run(checkpoint, key);
      const entries = this.#db.prepare('SELECT * FROM memories WHERE batch_id = ? ORDER BY seq').all(batchId).map(memoryRecord);
      return { entries, checkpoint, epoch: state.epoch };
    });
  }

  /** 最近 limit 条，以提交顺序返回；更早条目继续留在数据库中。 */
  entries(key, { limit = 500 } = {}) {
    checkKey(key);
    checkInteger(limit, 'limit');
    return this.#db.prepare('SELECT * FROM memories WHERE conversation_key = ? ORDER BY seq DESC LIMIT ?')
      .all(key, limit).reverse().map(memoryRecord);
  }

  /** 按持久化 seq 分页重放全部摘要历史，供派生索引重建；每页最多 100 条。 */
  entriesAfter(key, { after = 0, limit = 100 } = {}) {
    checkKey(key);
    checkInteger(after, 'after');
    checkInteger(limit, 'limit');
    return this.#db.prepare('SELECT * FROM memories WHERE conversation_key = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(key, after, Math.min(100, limit)).map(memoryRecord);
  }

  /** 明确遗忘才删除本 key 的 RAW/摘要/批次，并持久化新 epoch 拒绝旧在途结果。 */
  forget(key) {
    checkKey(key);
    return this.#transaction(() => {
      const { epoch } = this.#ensureState(key);
      this.#db.prepare('DELETE FROM memories WHERE conversation_key = ?').run(key);
      this.#db.prepare('DELETE FROM extractions WHERE conversation_key = ?').run(key);
      this.#db.prepare('DELETE FROM raw_messages WHERE conversation_key = ?').run(key);
      this.#db.prepare('UPDATE conversation_state SET checkpoint = 0, epoch = ? WHERE conversation_key = ?').run(epoch + 1, key);
      return { checkpoint: 0, epoch: epoch + 1 };
    });
  }
}
