// 从 bridge.js 抽取实际函数，在独立 VM 与临时文件中验证；不启动桥接或连接账号。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildProfilePrompt, parseProfileReply, saveStore } from '../src/long-memory.js';

const bridgeSource = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const KEY = 'group:456';
const plain = (value) => JSON.parse(JSON.stringify(value));

// bridge.js 的顶层与 main 内函数均以同缩进的独立右花括号结束。
function extractFunction(name) {
  const start = new RegExp(`^(  )?(?:async )?function ${name}\\(`, 'm').exec(bridgeSource);
  assert.ok(start, `实际函数 ${name} 必须存在`);
  const tail = bridgeSource.slice(start.index);
  const end = new RegExp(`^${start[1] || ''}\\}`, 'm').exec(tail);
  assert.ok(end, `实际函数 ${name} 必须完整提取`);
  return tail.slice(0, end.index + end[0].length);
}

const functionNames = [
  'readJsonSafe', 'renameWithRetry', 'atomicWriteJson', 'canonicalV2Key',
  'normalizeSpeakerIdsV2', 'pickWakeTriggersV2', 'defaultWakeConfigV2', 'refreshDefaultWakeConfigV2',
  'getSocialV2State', 'saveSocialV2State', 'loadSocialV2State',
  'snapshotV2BeforeRotate', 'restoreV2AfterRotate',
  'saveLongMemory', 'maybeRefreshProfile', 'refreshProfile'
];
const functionsSource = functionNames.map(extractFunction).join('\n');
const triggerKeysSource = bridgeSource.match(/^  const WAKE_TRIGGER_KEYS = .+;/m)?.[0];
assert.ok(triggerKeysSource);

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempRoot, 'qq-memory-regressions-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), tempRoot);
    assert.ok(path.basename(temp).startsWith('qq-memory-regressions-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const calls = { prompts: [], logs: [] };
  const cfg = { socialV2: { wake: {} } };
  const longMemoryConfig = { profileRefreshTurns: 5, profileMaxChars: 400 };
  const context = vm.createContext({
    fs, path, crypto, process, structuredClone,
    cfg, dshReady: true,
    SOCIAL_V2_FILE: path.join(temp, 'social-v2.json'),
    LONG_MEMORY_FILE: path.join(temp, 'long-memory.json'),
    socialV2: { paused: false, conversations: new Map() },
    seenForwardIds: new Map(),
    longMemoryState: { store: { conversations: {}, profiles: {} } },
    longMemoryChain: Promise.resolve(),
    longMemoryCfg: () => longMemoryConfig,
    memoryJournal: { epoch: () => 0 }, projectJournalMemory() {},
    buildProfilePrompt, parseProfileReply, saveLongMemoryStore: saveStore,
    // 只替换与本次缺陷无关的定时调度、账号注册和外部模型调用。
    rememberAgentToken() {}, scheduleProactiveCheckV2() {}, setupSleepTimerV2() {},
    ensureWakeableV2() {},
    sanitizeForwardId: (value) => String(value ?? ''),
    ensureSlangLearnerSession: async () => 'fixture-learner',
    api: { sessions: { prompt: async (request) => {
      calls.prompts.push(plain(request));
      return { result: { ok: true } };
    } } },
    waitLearnerTurn: async () => '新的画像：相处自然，喜欢认真讨论。',
    localDateTime: () => '2026-10-23 12:00:00',
    log: (...args) => calls.logs.push(args)
  });
  vm.runInContext(`${triggerKeysSource}\n${functionsSource}`, context, { filename: 'bridge-memory-fixture.js' });
  return { context, calls, longMemoryConfig };
}

const memberImpressions = {
  '小林（群名片）': {
    traits: ['喜欢摄影', '不喜欢被催促', '周末常去爬山'],
    interactionCount: 17,
    lastSeenAt: 1792700000000,
    extra: { note: '既有字段也应保留' }
  },
  '阿明 / Ming': {
    traits: ['研究本地模型', '喜欢简洁回答'],
    interactionCount: 6,
    lastSeenAt: 1792700001000
  }
};

test('轮换快照保留多个成员的原名、全部 traits 和既有字段', (t) => {
  const { context: h } = fixture(t);
  h.getSocialV2State(KEY).memberImpressions = structuredClone(memberImpressions);
  const keep = h.snapshotV2BeforeRotate(KEY);
  assert.deepEqual(plain(keep.impressions), memberImpressions);
});

test('空成员印象在轮换、落盘和重载后仍是空对象，恢复计数为 0', (t) => {
  const { context: h, calls } = fixture(t);
  h.getSocialV2State(KEY);
  const keep = h.snapshotV2BeforeRotate(KEY);
  h.socialV2.conversations.delete(KEY);
  assert.deepEqual(plain(h.restoreV2AfterRotate(KEY, keep)), { recent: 0, impressions: 0 });
  assert.deepEqual(plain(h.getSocialV2State(KEY).memberImpressions), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(h.SOCIAL_V2_FILE, 'utf8')).conversations[KEY].memberImpressions, {});
  h.socialV2.conversations.clear();
  h.loadSocialV2State();
  assert.deepEqual(plain(h.getSocialV2State(KEY).memberImpressions), {});
  assert.deepEqual(calls.logs, []);
});

test('轮换恢复的完整成员对象经过实际保存与重载保留，其他窗口范围不变', (t) => {
  const { context: h, calls } = fixture(t);
  const expected = { ...structuredClone(memberImpressions) };
  for (let i = 0; i < 33; i++) {
    expected[`成员${i}`] = { traits: [`偏好${i}`], interactionCount: i + 1, lastSeenAt: 1792700002000 + i };
  }
  const st = h.getSocialV2State(KEY);
  st.memberImpressions = expected;
  st.recentMessages = Array.from({ length: 105 }, (_, seq) => ({ seq, text: `消息${seq}` }));
  st.activeTopics = Array.from({ length: 12 }, (_, i) => ({ text: `话题${i}` }));
  st.pendingThoughts = Array.from({ length: 13 }, (_, i) => ({ text: `想法${i}` }));
  const keep = h.snapshotV2BeforeRotate(KEY);
  h.socialV2.conversations.delete(KEY);
  assert.deepEqual(plain(h.restoreV2AfterRotate(KEY, keep)), { recent: 100, impressions: 35 });
  const persisted = JSON.parse(fs.readFileSync(h.SOCIAL_V2_FILE, 'utf8')).conversations[KEY];
  assert.deepEqual(persisted.memberImpressions, expected);
  h.socialV2.conversations.clear();
  h.loadSocialV2State();
  const restored = h.getSocialV2State(KEY);
  assert.deepEqual(plain(restored.memberImpressions), expected);
  assert.deepEqual(plain(restored.recentMessages), st.recentMessages.slice(-100));
  assert.deepEqual(plain(restored.activeTopics), st.activeTopics.slice(-10));
  assert.deepEqual(plain(restored.pendingThoughts), st.pendingThoughts.slice(-10));
  assert.notEqual(restored.agentToken, st.agentToken);
  assert.deepEqual(calls.logs, []);
});

test('画像刷新调用链保留成员名及全部 traits，并继续携带话题、旧画像和摘要', async (t) => {
  const { context: h, calls } = fixture(t);
  const st = h.getSocialV2State(KEY);
  st.memberImpressions = structuredClone(memberImpressions);
  st.activeTopics = ['周末去哪里', { target: '共同话题', content: '相机选型' }, { text: '近期模型实验' }];
  h.longMemoryState.store.profiles[KEY] = { text: '旧画像：说话直接但愿意帮忙。', turns: 3 };
  h.longMemoryState.store.conversations[KEY] = [
    { t: '2026-10-22 10:00:00', summary: '约好周六一起拍照' },
    { t: '2026-10-22 11:00:00', summary: '最近在准备毕业设计' }
  ];
  h.maybeRefreshProfile(KEY);
  await h.longMemoryChain;
  assert.equal(calls.prompts.length, 0, '刷新阈值之前不能调用模型');
  assert.equal(h.longMemoryState.store.profiles[KEY].turns, 4);
  h.maybeRefreshProfile(KEY);
  await h.longMemoryChain;
  assert.equal(calls.prompts.length, 1, '到达既有刷新阈值时调用一次模型');
  const delivered = calls.prompts[0].content[0].text;
  for (const [name, impression] of Object.entries(memberImpressions)) {
    assert.ok(delivered.includes(name), `画像输入必须保留成员名 ${name}`);
    for (const trait of impression.traits) assert.ok(delivered.includes(trait), `画像输入必须保留 ${name} 的特征 ${trait}`);
  }
  for (const text of ['周末去哪里', '共同话题', '相机选型', '近期模型实验', '旧画像：说话直接但愿意帮忙。', '约好周六一起拍照', '最近在准备毕业设计']) {
    assert.ok(delivered.includes(text), `既有画像输入 ${text} 应保留`);
  }
  assert.deepEqual(st.memberImpressions, memberImpressions, '画像映射不应改写成员印象');
  const saved = JSON.parse(fs.readFileSync(h.LONG_MEMORY_FILE, 'utf8'));
  assert.equal(saved.profiles[KEY].text, '新的画像：相处自然，喜欢认真讨论。');
  assert.equal(saved.profiles[KEY].turns, 0);
});

test('画像刷新继续接受既有数组中的字符串、target/content 与 target/text', async (t) => {
  const { context: h, calls } = fixture(t);
  h.getSocialV2State(KEY).memberImpressions = [
    '旧字符串印象',
    { target: '旧成员甲', content: '原 content 内容' },
    { target: '旧成员乙', text: '原 text 内容' }
  ];
  h.longMemoryState.store.profiles[KEY] = { text: '', turns: 4 };
  h.maybeRefreshProfile(KEY);
  await h.longMemoryChain;
  assert.equal(calls.prompts.length, 1);
  const delivered = calls.prompts[0].content[0].text;
  for (const text of ['旧字符串印象', '旧成员甲', '原 content 内容', '旧成员乙', '原 text 内容']) {
    assert.ok(delivered.includes(text));
  }
});
