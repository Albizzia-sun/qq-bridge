import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const MEMOS_ENGINE = '@memtensor/memos-local-plugin@2.0.16-beta.1';
const AGENT = 'qq-bridge-shadow';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function remoteConfig(value, label) {
  if (!value?.endpoint || !value?.model || !value?.apiKeyEnv || !process.env[value.apiKeyEnv]) {
    throw failure('MEMOS_CONFIG_REQUIRED', `${label} requires endpoint, model, apiKeyEnv and its environment variable`);
  }
  let url;
  try { url = new URL(value.endpoint); } catch {
    throw failure('MEMOS_CONFIG_REQUIRED', `${label}.endpoint must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw failure('MEMOS_CONFIG_REQUIRED', `${label}.endpoint must be an HTTP(S) URL without embedded credentials`);
  }
  return { endpoint: url.href.replace(/\/+$/, ''), model: value.model, apiKey: process.env[value.apiKeyEnv] };
}

function identity(...parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function positiveInteger(value, fallback, field) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw failure('MEMOS_CONFIG_REQUIRED', `${field} must be a positive integer`);
  return n;
}

function databasePath(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw failure('MEMOS_CONFIG_REQUIRED', 'rootDir is required');
  return path.join(path.resolve(rootDir), 'state', 'memos-shadow', 'memos.db');
}

function conversationNamespace(conversationKey) {
  if (typeof conversationKey !== 'string' || !conversationKey.trim()) throw new TypeError('conversationKey must be non-empty');
  return { agentKind: AGENT, profileId: identity(conversationKey) };
}

function purgeConversation(rawDb, ns) {
  return rawDb.transaction(() => {
    const owner = { agent: AGENT, owner: ns.profileId };
    const condition = 'owner_agent_kind=@agent AND owner_profile_id=@owner';
    // Same deletion order as the pinned official trace repository. Delete FTS
    // explicitly as well as via its trigger, then let foreign keys clear sources.
    rawDb.prepare(`DELETE FROM traces_fts WHERE trace_id IN (SELECT id FROM traces WHERE ${condition})`).run(owner);
    const deleted = rawDb.prepare(`DELETE FROM traces WHERE ${condition}`).run(owner).changes;
    rawDb.prepare(`DELETE FROM episodes WHERE ${condition}`).run(owner);
    rawDb.prepare(`DELETE FROM sessions WHERE ${condition}`).run(owner);
    return { engine: MEMOS_ENGINE, mode: 'shadow', status: 'ok', deleted };
  })();
}

/** Local-only forgetting also works if providers are unavailable or Shadow is off. */
export async function forgetMemosShadow({ rootDir, conversationKey } = {}) {
  const file = databasePath(rootDir);
  const ns = conversationNamespace(conversationKey);
  try { fs.statSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { engine: MEMOS_ENGINE, mode: 'shadow', status: 'ok', deleted: 0 };
    throw error;
  }
  // Resolve the native dependency from the pinned package, including installations
  // where npm does not hoist it. fileMustExist prevents accidentally creating a DB.
  const require = createRequire(import.meta.resolve('@memtensor/memos-local-plugin'));
  const Database = require('better-sqlite3');
  const rawDb = new Database(file, { fileMustExist: true });
  try {
    rawDb.pragma('foreign_keys = ON');
    return purgeConversation(rawDb, ns);
  } finally { rawDb.close(); }
}

/**
 * Owns only a derived MemOS index. The caller owns RAW persistence, extraction,
 * ordering and the shadow comparison log. No DSH hook or prompt is registered.
 *
 * Storage, embeddings, FTS/vector candidates and RRF/MMR are the pinned official
 * MemOS components. The full capture/evolution pipeline is intentionally absent:
 * input records have already been extracted by the bridge's existing pipeline.
 *
 * Remote embedding uses the OpenAI-compatible /embeddings contract. Optional
 * reranking uses POST {model, query, documents, top_n} -> results[index,
 * relevance_score]. Secrets are resolved only from the named environment vars.
 * Provider failures are surfaced; official FTS degradation is labelled in search
 * metadata. Methods must be serialized by the owning bridge queue before close.
 * The embedding endpoint/model are pinned in this derived index. A mismatch fails
 * explicitly; model migration is outside this adapter's contract.
 */
export async function createMemosShadow({ rootDir, config = {}, logger = () => {} } = {}) {
  const base = { engine: MEMOS_ENGINE, mode: 'shadow' };
  if (config.enabled !== true) {
    return {
      upsert: async () => ({ ...base, status: 'disabled', written: 0 }),
      search: async () => ({ ...base, status: 'disabled', results: [] }),
      forget: (conversationKey) => forgetMemosShadow({ rootDir, conversationKey }),
      close: async () => {},
    };
  }
  const file = databasePath(rootDir);
  // Validate before opening storage: missing providers must never select MemOS's
  // default local model or silently download model weights.
  const embeddingConfig = remoteConfig(config.embedding, 'embedding');
  const rerankerConfig = config.reranker && config.reranker.enabled !== false
    ? remoteConfig(config.reranker, 'reranker') : null;
  const timeoutMs = positiveInteger(config.timeoutMs, 3000, 'timeoutMs');
  const topK = positiveInteger(config.topK, 6, 'topK');
  const [{ openDb, runMigrations, makeRepos }, { createEmbedder },
    { toolDrivenRetrieve }, { wrapRetrievalRepos }, { DEFAULT_CONFIG }] = await Promise.all([
    import('@memtensor/memos-local-plugin/dist/core/storage/index.js'),
    import('@memtensor/memos-local-plugin/dist/core/embedding/index.js'),
    import('@memtensor/memos-local-plugin/dist/core/retrieval/index.js'),
    import('@memtensor/memos-local-plugin/dist/core/pipeline/retrieval-repos.js'),
    import('@memtensor/memos-local-plugin/dist/core/config/defaults.js'),
  ]);
  const db = openDb({ filepath: file, agent: AGENT });
  let embedder;
  let repos;
  let closed = false;
  try {
    runMigrations(db);
    // Adapter-owned provenance is separate from the official memory schema.
    db.exec(`CREATE TABLE IF NOT EXISTS qq_shadow_sources (
      trace_id TEXT PRIMARY KEY REFERENCES traces(id) ON DELETE CASCADE,
      owner_profile_id TEXT NOT NULL, original_id TEXT NOT NULL,
      source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json))
    ); CREATE INDEX IF NOT EXISTS qq_shadow_sources_owner ON qq_shadow_sources(owner_profile_id);`);
    db.exec('CREATE TABLE IF NOT EXISTS qq_shadow_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.tx(() => {
      const contract = JSON.stringify({ endpoint: embeddingConfig.endpoint, model: embeddingConfig.model });
      const stored = db.prepare("SELECT value FROM qq_shadow_config WHERE key='embedding'").get();
      if (stored && stored.value !== contract) {
        throw failure('MEMOS_EMBEDDING_MISMATCH', 'The derived index uses a different embedding endpoint/model');
      }
      if (!stored) {
        if (db.prepare('SELECT 1 FROM traces LIMIT 1').get()) {
          throw failure('MEMOS_EMBEDDING_MISMATCH', 'The existing derived index has no recorded embedding endpoint/model');
        }
        db.prepare("INSERT INTO qq_shadow_config(key,value) VALUES ('embedding', @value)").run({ value: contract });
      }
    });
    repos = makeRepos(db);
    embedder = createEmbedder({
      ...DEFAULT_CONFIG.embedding,
      ...embeddingConfig,
      provider: 'openai_compatible',
      dimensions: 0,
      timeoutMs,
      maxRetries: 0,
      // Record-level idempotency is durable in SQLite. No second in-memory
      // copy of conversation text/vectors is needed on the small deployment.
      cache: { enabled: false, maxItems: 1 },
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const retrievalConfig = {
    ...DEFAULT_CONFIG.algorithm.retrieval,
    tier1TopK: 0, tier2TopK: topK, tier3TopK: 0,
    lightweightMemory: true,
    // Existing bridge summaries have no MemOS reward score. Query all of them
    // instead of manufacturing a positive reward merely to pass its filter.
    includeLowValue: true,
    decayHalfLifeDays: DEFAULT_CONFIG.algorithm.reward.decayHalfLifeDays,
    llmFilterEnabled: false,
    ftsTokenizer: DEFAULT_CONFIG.storage.ftsTokenizer,
  };
  const sourceFor = db.prepare('SELECT * FROM qq_shadow_sources WHERE trace_id=@id AND owner_profile_id=@owner');
  const saveSource = db.prepare('INSERT INTO qq_shadow_sources(trace_id,owner_profile_id,original_id,source_ids_json) VALUES (@id,@owner,@original,@sources)');

  function namespaceFor(conversationKey) {
    if (closed) throw failure('MEMOS_CLOSED', 'MemOS Shadow is closed');
    // Hash the complete key: private/group keys and punctuation stay distinct,
    // unlike MemOS normalizeNamespace's lossy identifier normalization.
    return conversationNamespace(conversationKey);
  }

  async function rerank(query, results) {
    if (!rerankerConfig) return { results, metadata: { status: 'disabled' } };
    if (!results.length) return { results, metadata: { status: 'empty' } };
    let response;
    try {
      response = await fetch(rerankerConfig.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rerankerConfig.apiKey}` },
        body: JSON.stringify({ model: rerankerConfig.model, query, documents: results.map((r) => r.text), top_n: topK }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.results)) throw new Error('response.results must be an array');
      const seen = new Set();
      const ranked = body.results.map((row) => {
        if (!Number.isInteger(row.index) || row.index < 0 || row.index >= results.length ||
          seen.has(row.index) || !Number.isFinite(row.relevance_score)) throw new Error('invalid reranker result');
        seen.add(row.index);
        return { ...results[row.index], rerankScore: row.relevance_score };
      });
      return { results: ranked, metadata: { status: 'ok', model: rerankerConfig.model } };
    } catch (error) {
      throw failure('MEMOS_RERANK_FAILED', `Remote reranker failed: ${error.message}`);
    }
  }

  return {
    async upsert(conversationKey, records) {
      const ns = namespaceFor(conversationKey);
      if (!Array.isArray(records)) throw new TypeError('records must be an array');
      const pending = [];
      const seen = new Set();
      for (const record of records) {
        if (typeof record.id !== 'string' || !record.id || typeof record.text !== 'string' || !record.text.trim() ||
          !Array.isArray(record.sourceIds) || !record.sourceIds.every((id) => typeof id === 'string')) {
          throw new TypeError('records require non-empty id/text and string[] sourceIds');
        }
        if (seen.has(record.id)) throw new TypeError('record ids must be unique within one upsert');
        seen.add(record.id);
        const id = identity(conversationKey, record.id);
        const previous = repos.traces.getById(id);
        const source = sourceFor.get({ id, owner: ns.profileId });
        const sources = JSON.stringify(record.sourceIds);
        if (previous?.userText === record.text && source?.source_ids_json === sources) continue;
        pending.push({ record, id, sources, previous });
      }
      if (!pending.length) return { ...base, status: 'ok', written: 0, unchanged: records.length };
      // Complete remote work before beginning the synchronous SQLite transaction.
      // A provider failure leaves every previous record available unchanged.
      const vectors = [];
      for (const item of pending) vectors.push(await embedder.embedOne({ text: item.record.text, role: 'document' }));
      db.tx(() => {
        const now = Date.now();
        const sessionId = ns.profileId;
        const owner = { ownerAgentKind: AGENT, ownerProfileId: ns.profileId, ownerWorkspaceId: null };
        if (!repos.sessions.getById(sessionId)) repos.sessions.upsert({ id: sessionId, agent: AGENT, ...owner, startedAt: now, lastSeenAt: now, meta: {} });
        else repos.sessions.touch(sessionId, now, {});
        pending.forEach(({ record, id, sources, previous }, i) => {
          const episodeId = `shadow-${id}`;
          if (!repos.episodes.getById(episodeId)) repos.episodes.insert({ id: episodeId, sessionId, ...owner, startedAt: now, endedAt: now, traceIds: [id], rTask: null, status: 'closed', share: { scope: 'private' } });
          if (previous) repos.traces.deleteById(id);
          repos.traces.insert({
            id, episodeId, sessionId, ...owner, ts: previous?.ts ?? now,
            userText: record.text, agentText: '', summary: record.text,
            toolCalls: [], reflection: null, value: 0, alpha: 0, rHuman: null,
            priority: 0, tags: [], errorSignatures: [], vecSummary: vectors[i],
            vecAction: null, share: { scope: 'private' }, turnId: 0, schemaVersion: 1,
          });
          saveSource.run({ id, owner: ns.profileId, original: record.id, sources });
        });
      });
      return { ...base, status: 'ok', written: pending.length, unchanged: records.length - pending.length };
    },

    async search(conversationKey, query) {
      const ns = namespaceFor(conversationKey);
      if (typeof query !== 'string') throw new TypeError('query must be a string');
      const started = Date.now();
      const { packet, stats } = await toolDrivenRetrieve({
        repos: wrapRetrievalRepos(repos, ns), namespace: ns,
        embedder: { embed: (text, role, options) => embedder.embedOne({ text, role }, options) },
        config: retrievalConfig, now: Date.now, llm: null,
      }, {
        reason: 'tool_driven', agent: AGENT, namespace: ns,
        sessionId: ns.profileId, tool: 'qq_shadow_search', args: { query }, ts: started,
      }, { skipLlmFilter: true, deadlineAt: started + timeoutMs });
      const candidates = packet.snippets.map((snippet) => {
        const source = sourceFor.get({ id: snippet.refId, owner: ns.profileId });
        const row = repos.traces.getById(snippet.refId);
        if (!source || !row || row.ownerAgentKind !== AGENT || row.ownerProfileId !== ns.profileId) {
          throw failure('MEMOS_SCOPE_MISMATCH', 'MemOS returned a memory outside the requested conversation');
        }
        return { id: source.original_id, text: row.userText, sourceIds: JSON.parse(source.source_ids_json), score: snippet.score, scoreDetails: snippet.scoreDetails };
      });
      const ranked = await rerank(query, candidates);
      const result = {
        ...base, status: stats.embedding.degraded ? 'degraded' : 'ok',
        results: ranked.results, embedding: stats.embedding,
        reranker: ranked.metadata, latencyMs: Date.now() - started,
        candidateCount: stats.rawCandidateCount,
      };
      if (typeof logger === 'function') logger('memos_shadow_search', { status: result.status, count: result.results.length, latencyMs: result.latencyMs });
      return result;
    },

    async forget(conversationKey) {
      const ns = namespaceFor(conversationKey);
      return purgeConversation(db.raw, ns);
    },

    async close() {
      if (closed) return;
      closed = true;
      try { await embedder.close(); } finally { db.close(); }
    },
  };
}
