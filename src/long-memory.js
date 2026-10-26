// 长期记忆：把每轮对话的「值得记住的部分」提炼成短条目，跨会话保留。
//
// 为什么需要它：DSH 会话的上下文会无限增长，最终撞上模型上限（实测 2026-10-22 报
// 400「Total tokens … exceed max message tokens」）。而「人格 / 印象 / 日记」本来就
// 在外部文件里，真正缺的是「这段日子聊过什么」的压缩形态。
//
// 三层结构（对齐 MaiBot / Letta 那类实现，但不引入向量库）：
//   1. 条目（entries）：每 8 条消息提炼一句，存 state/long-memory.json
//   2. 画像（profile）：每 20 轮把条目与印象压成一段稳定的人物画像
//   3. 日摘要（digest）：每天第一次唤醒时，带上「昨天她写了什么 + 昨天聊了什么」
//
// 读取不做全量回放：最近 N 条 + 与当前消息关键词相关的 K 条，整体受字符上限约束。
import fs from 'node:fs';

export const LONG_MEMORY_VERSION = 2;

// ── 通用 ────────────────────────────────────────────────────────────────

/** 把最近若干条消息压成 `谁: 内容` 的紧凑文本（不含任何元数据）。 */
export function compactTranscript(messages, { limit = 40, maxChars = 4000 } = {}) {
  const picked = (Array.isArray(messages) ? messages : []).slice(-Math.max(1, limit));
  const lines = [];
  for (const m of picked) {
    const text = String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const sender = String(m?.sender ?? '').trim();
    const who = m?.isSelf
      ? '她'
      : (!sender || sender === '私聊' ? '你' : `对方(${sender})`);
    lines.push(`${who}: ${text}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

/** 提炼提示词：只输出 JSON，便于解析；明确禁止寒暄与编造。 */
export function buildSummaryPrompt({ transcript, existing = [], maxEntryChars = 200 } = {}) {
  const existingText = Array.isArray(existing) && existing.length
    ? existing.slice(-8).map((e) => `- ${e.summary}`).join('\n')
    : '（还没有）';
  return [
    '你是记忆整理器，不参与聊天。下面是一段 QQ 私聊的最近对话。',
    '',
    '【已有的长期记忆】',
    existingText,
    '',
    '【最近对话】',
    transcript || '（空）',
    '',
    '请提炼**值得长期记住**的内容，最多 3 条：事实（工作/学业/身体/重要日期）、',
    '约定（答应过的事）、关系变化（吵架/和好/新的称呼）、他的偏好与雷点。',
    '',
    '规则：',
    `- 每条一句话，第三人称，不超过 ${maxEntryChars} 字，要具体（例如“他表示今天腰疼”）。`,
    '- 优先记录可核对的事实和对方的明确自述，保留说话主体及时间范围；暂时状态不概括为稳定性格，推测和评价不当成事实。',
    '- 对方的明确否认和纠正优先保留，写清否定了什么、现在怎样；即使已有相反记忆，也不能当作重复内容跳过。',
    '- 不得把对方的否认或纠正解释成某种性格的证据；不虚构关系默契、共同事件或承诺。',
    '- 不记寒暄、不记表情包、不记工具调用、不记你自己说过的话。',
    '- 和【已有的长期记忆】重复的不要重复提炼。',
    '- 如果这段对话没有值得记住的新内容，memories 返回空数组。',
    '',
    '只输出 JSON，不要任何解释或代码块：',
    '{"memories":[{"summary":"一句话","tags":["标签"]}]}',
    '没有可记内容时用 {"memories":[]}。'
  ].join('\n');
}

/** 解析提炼结果；容忍代码围栏与多余文字，失败返回空。 */
export function parseSummaryReply(text, maxEntryChars = 200) {
  const obj = parseJsonLoose(text);
  if (!obj) return { summary: '', tags: [] };
  let summary = String(obj?.summary ?? '').replace(/\s+/g, ' ').trim();
  if (summary.length > maxEntryChars) summary = summary.slice(0, maxEntryChars);
  const tags = Array.isArray(obj?.tags)
    ? obj.tags.map((t) => String(t ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
    : [];
  return { summary, tags };
}

/** 批量提取协议；合法空结果与非法输出必须区分，失败由调用方保留原处理水位。 */
export function parseSummaryBatch(text, maxEntryChars = 200) {
  const raw = String(text ?? '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  let obj;
  try { obj = JSON.parse(raw); }
  catch { obj = parseJsonLoose(raw); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Invalid memory extraction JSON object');
  const legacy = !Object.prototype.hasOwnProperty.call(obj, 'memories');
  const items = legacy ? [obj] : obj.memories;
  if (!Array.isArray(items) || items.length > 3) throw new Error('Invalid memories: expected an array of at most 3 entries');
  const memories = [];
  for (const item of items) {
    if (!item || Array.isArray(item) || typeof item.summary !== 'string') throw new Error('Invalid memory summary: expected a string');
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error('Invalid memory tags: expected an array of strings');
    }
    let summary = item.summary.replace(/\s+/g, ' ').trim();
    if (!summary) {
      if (legacy) continue;
      throw new Error('Invalid memory summary: empty entries must use memories: []');
    }
    if (summary.length > maxEntryChars) summary = summary.slice(0, maxEntryChars);
    if (!summary.trim()) throw new Error('Invalid memory summary length');
    const tags = (item.tags ?? []).map((tag) => tag.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4);
    memories.push({ summary, tags });
  }
  return { memories };
}

/** 宽松 JSON 解析：去掉 ``` 围栏、取第一个 { 到最后一个 }。 */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// ── 关键词与检索 ────────────────────────────────────────────────────────

const CJK_RUN = /[\u4e00-\u9fff]+/g;
const WORD_RUN = /[A-Za-z][A-Za-z0-9_+#.-]{1,}/g;
const STOP_BIGRAMS = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '不是', '一个', '现在', '今天', '明天', '昨天']);

/**
 * 从一句话里抽关键词：
 *   · 中文取 2-gram（"腰疼"→腰疼；"不吃饭"→不吃/吃饭）
 *   · 英文/数字取长度 ≥2 的词
 * 只用于「这条记忆跟当前这句话有没有关系」的粗打分，不追求分词精度。
 */
export function extractKeywords(text, { max = 40 } = {}) {
  const s = String(text ?? '');
  const out = new Set();
  for (const run of s.match(CJK_RUN) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 2 <= run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (STOP_BIGRAMS.has(bigram)) continue;
      out.add(bigram);
      if (out.size >= max) return out;
    }
  }
  for (const w of s.match(WORD_RUN) ?? []) {
    out.add(w.toLowerCase());
    if (out.size >= max) return out;
  }
  return out;
}

function entryKeywords(entry) {
  if (!entry.__kw) {
    // 缓存挂在对象上，进程内复用；条目本身不进 JSON 持久化。
    Object.defineProperty(entry, '__kw', { value: extractKeywords(entry.summary), enumerable: false, configurable: true });
  }
  return entry.__kw;
}

/** 相关度打分：关键词重合数 + 轻微的时间新鲜度加成。 */
export function scoreEntry(entry, keywords, now = Date.now()) {
  if (!keywords || !keywords.size) return 0;
  let hits = 0;
  for (const kw of entryKeywords(entry)) if (keywords.has(kw)) hits += 1;
  if (!hits) return 0;
  const ageDays = Math.max(0, (now - Date.parse(String(entry?.t ?? '').replace(' ', 'T'))) / 86400000);
  return hits + Math.max(0, 1 - ageDays / 30); // 30 天外不再有新鲜度加成
}

/**
 * 选出这次要注入的条目：**最近 N 条 + 与当前消息相关的 K 条**。
 * 返回按时间升序的条目数组（不重复）。
 *
 * minHits：相关条目的最低得分（本机新增）。原来只要 `score > 0`（命中 1 个中文
 * 2-gram 就算"相关"），实测「王者荣耀打不打」也能把整段吵架记忆拉进来。
 *
 * 命中按**词频加权**：
 *   · 罕见词（整个档案里只出现在 ≤2 条记忆里，比如"针灸""冻梨"）记 2 分；
 *   · 常见词（"他说""今天"这类到处都有的 2-gram）记 1 分。
 * 于是 minHits=2 的语义是：**要么命中两个普通词，要么命中一个罕见词**。
 */
export function selectMemory(entries, { query = '', recentCount = 6, relevantCount = 6, minHits = 2, now = Date.now() } = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const picked = new Map();
  const recent = entries.slice(-Math.max(0, recentCount));
  for (const e of recent) picked.set(e, true);
  const keywords = extractKeywords(query);
  if (keywords.size && relevantCount > 0) {
    // 先算每个关键词在档案里覆盖几条记忆（文档频率），用来判断它稀有还是常见。
    const df = new Map();
    for (const e of entries) {
      for (const kw of entryKeywords(e)) if (keywords.has(kw)) df.set(kw, (df.get(kw) ?? 0) + 1);
    }
    const weightOf = (kw) => ((df.get(kw) ?? 0) <= 2 ? 2 : 1);
    const threshold = Math.max(1, Number(minHits) || 1);
    const scored = entries
      .filter((e) => !picked.has(e))
      .map((e) => {
        let hits = 0;
        let weighted = 0;
        for (const kw of entryKeywords(e)) {
          if (!keywords.has(kw)) continue;
          hits += 1;
          weighted += weightOf(kw);
        }
        return { e, hits, weighted, score: weighted + Math.max(0, 1 - Math.max(0, (now - Date.parse(String(e?.t ?? '').replace(' ', 'T'))) / 86400000) / 30) * 0.5 };
      })
      .filter((x) => x.hits > 0 && x.weighted >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, relevantCount);
    for (const { e } of scored) picked.set(e, true);
  }
  return [...picked.keys()].sort((a, b) => String(a?.t ?? '').localeCompare(String(b?.t ?? '')));
}

// ── 提示词渲染 ──────────────────────────────────────────────────────────

/** 把一组条目渲染成注入文本（含表头，整体受 maxChars 限制）。 */
export function formatMemoryForPrompt(entries, { maxEntries = 12, maxChars = 3000, header = '' } = {}) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const picked = entries.slice(-Math.max(1, maxEntries));
  const lines = [];
  for (const e of picked) {
    const day = String(e?.t ?? '').slice(5, 10); // MM-DD
    const summary = String(e?.summary ?? '').trim();
    if (!summary) continue;
    lines.push(day ? `${day} ${summary}` : summary);
  }
  if (!lines.length) return '';
  const head = header || '【长期记忆】（跨会话保留，越靠后越新；当前明确表达和纠正优先，旧印象不得用于否定当前；细节可以问他，不要假装记得原话）';
  const budget = Math.max(200, maxChars - head.length - 2);
  let body = lines.join('\n');
  if (body.length > budget) body = body.slice(body.length - budget);
  return `${head}\n${body}\n\n`;
}

function formatProfileCorrections(corrections) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  return (Array.isArray(corrections) ? corrections : [])
    .map((item) => ({ target: clean(item?.target), oldContent: clean(item?.oldContent), content: clean(item?.content) }))
    .filter((item) => item.oldContent || item.content)
    .map((item) => `- 对象：${item.target}；被纠正原文：${item.oldContent}；${item.content
      ? `纠正为：${item.content}`
      : '已撤回，不再作为画像依据；不据此推断相反事实'}`)
    .join('\n');
}

/** 人物画像注入文本；明确纠正独立于正文预算，不能因正文清空或截断而失效。 */
export function formatProfileForPrompt(profile, { maxChars = 500 } = {}) {
  const text = String(profile?.text ?? '').replace(/\s+/g, ' ').trim();
  const corrections = formatProfileCorrections(profile?.corrections);
  if (!text && !corrections) return '';
  const head = '【你对他这个人的了解】（历史印象，可能过时，不是逐字记录；当前明确表达和纠正优先，旧印象不得用于否定当前）';
  const budget = Math.max(120, maxChars - head.length - 2);
  const body = text ? `${head}\n${text.slice(0, budget)}\n\n` : '';
  return body + (corrections
    ? `【已明确纠正/撤回（优先于旧摘要；引用的旧原文已撤销，不是当前事实；多次纠正以最后一次与当前印象为准）】\n${corrections}\n\n`
    : '');
}

/** 画像提炼提示词。 */
export function buildProfilePrompt({ existing = '', memories = [], impressions = [], corrections = [], maxChars = 400 } = {}) {
  const memText = (Array.isArray(memories) ? memories : []).slice(-20)
    .filter((e) => String(e?.summary ?? '').trim())
    .map((e) => {
      const time = String(e?.t ?? e?.time ?? '').trim();
      return `- ${time ? `[记录时间：${time}] ` : ''}${String(e.summary).trim()}`;
    }).join('\n') || '（无）';
  const impText = (Array.isArray(impressions) ? impressions : [])
    .map((x) => (typeof x === 'string' ? x : `${x?.target ?? ''} ${x?.content ?? x?.text ?? ''}`))
    .map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-10).join('；') || '（无）';
  const correctionText = formatProfileCorrections(corrections) || '（无）';
  return [
    '你是人物画像整理器，不参与聊天。请根据下面的材料，写一段「这个人是什么样的」的画像。',
    '',
    `【现有画像】\n${existing || '（还没有）'}`,
    '',
    `【最近的记忆条目】\n${memText}`,
    '',
    `【对他的印象】\n${impText}`,
    '',
    `【明确纠正】\n${correctionText}`,
    '',
    '规则：',
    `- 一段话，不分行，不超过 ${maxChars} 字。`,
    '- 只写有事实或明确自述支持的习惯、偏好、雷点、重要处境（工作/学业/身体）；不把单次观察或暂时情绪升级为稳定性格。',
    '- 旧画像不是独立证据，印象也可能是推断；无新证据时不得扩写旧画像或补写故事，缺少依据的内容不写。',
    '- 明确纠正和对方当前的明确自述优先；旧摘要或旧画像里已被否定的内容不得恢复，也不得把否认、纠正解释成性格证据。',
    '- 纠正材料中引用的旧原文已撤销，不是当前事实；多次纠正以最后一次与当前印象为准，撤回不代表相反事实成立。',
    '- 根据材料的时间范围区分历史与当前，已经不成立的内容要改掉；记录时间不等于事件发生时间，不能据此编造发生日期。',
    '- 不写寒暄，不虚构关系默契、共同事件或承诺；区分对方自述与观察，不把推测写成确定了解。',
    '- ★ 人称：写他时用「他」；写到你自己时用「我」（例如「我提醒过他这个月要开始看书」）。',
    '  不要用「她」指代你自己——这段画像会以第一人称「我了解他」的口吻注入给你自己读。',
    '- ★ 只写他还成立的事：写不写"我"做过什么，只在与理解他有关时写（例如约定、提醒），别写成流水账。',
    '',
    '直接输出画像正文，不要标题、不要 JSON、不要解释。'
  ].join('\n');
}

/** 解析画像结果：去围栏、压成一行、截断。 */
export function parseProfileReply(text, maxChars = 400) {
  let s = String(text ?? '').trim();
  if (!s) return '';
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  s = s.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  s = s.replace(/^【[^】]*】\s*/, '').replace(/^(画像|人物画像)[:：]\s*/, '');
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

// ── 每日摘要 ────────────────────────────────────────────────────────────

/** 昨天的日期字符串（YYYY-MM-DD），用于筛选条目与日记。 */
export function yesterdayString(now = Date.now()) {
  const d = new Date(now - 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 昨日摘要：把「昨天她写的日记」+「昨天的记忆条目」拼成一小段。
 * 不用额外模型调用——日记本身就是她写过的压缩版，条目已经是提炼过的。
 */
export function buildDailyDigest({ entries = [], diaryLines = [], day = yesterdayString(), maxChars = 800 } = {}) {
  const parts = [];
  const diary = (Array.isArray(diaryLines) ? diaryLines : [])
    .map((l) => {
      try {
        const o = typeof l === 'string' ? JSON.parse(l) : l;
        return o && String(o.time ?? '').startsWith(day) ? { mood: o.mood, content: o.content } : null;
      } catch { return null; }
    })
    .filter(Boolean);
  for (const d of diary) {
    if (!d?.content) continue;
    parts.push(`你昨天写的：${d.mood ? `（${d.mood}）` : ''}${String(d.content).trim()}`);
  }
  const mems = (Array.isArray(entries) ? entries : [])
    .filter((e) => String(e?.t ?? '').startsWith(day) && e?.summary)
    .map((e) => `- ${String(e.summary).trim()}`);
  if (mems.length) parts.push(`昨天记下的：\n${mems.slice(-8).join('\n')}`);
  if (!parts.length) return '';
  let body = parts.join('\n');
  const head = '【昨天】（新的一天开始了，这些是昨天的，别当成刚发生的）';
  const budget = Math.max(200, maxChars - head.length - 2);
  if (body.length > budget) body = body.slice(body.length - budget);
  return `${head}\n${body}\n\n`;
}

// ── 存储 ────────────────────────────────────────────────────────────────

/**
 * 存储结构：
 * {
 *   version: 2,
 *   conversations: { [key]: [{ t, summary, tags }] },
 *   profiles:      { [key]: { text, updatedAt, turns } }
 * }
 */
export function loadStore(file) {
  const empty = { version: LONG_MEMORY_VERSION, conversations: {}, profiles: {}, lastDigest: {} };
  try {
    if (!fs.existsSync(file)) return empty;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      version: LONG_MEMORY_VERSION,
      conversations: parsed.conversations && typeof parsed.conversations === 'object' ? parsed.conversations : {},
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      lastDigest: parsed.lastDigest && typeof parsed.lastDigest === 'object' ? parsed.lastDigest : {}
    };
  } catch {
    return empty;
  }
}

export function appendEntry(store, key, entry, { maxEntries = 500 } = {}) {
  if (!store.conversations[key]) store.conversations[key] = [];
  const list = store.conversations[key];
  list.push(entry);
  if (list.length > maxEntries) store.conversations[key] = list.slice(-maxEntries);
  return store;
}

export function saveStore(file, store) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
