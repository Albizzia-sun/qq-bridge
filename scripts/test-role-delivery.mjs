// Real wake construction/delivery with temporary role files and a fake DSH peer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';
const CARD = '# Fixture role\nA concrete conversational role v1.';
const UPDATED = '# Fixture role\nA revised conversational role v2 with different text.';
const accepted = () => ({ result: { ok: true, value: {} } });
const textOf = prompt => prompt.content.filter(p => p.type === 'text').map(p => p.text).join('\n');

async function fixture(run, extra = {}) {
  const h = await bridgeHarness({
    config: { role: { injectInV2Prompt: true }, socialV2: {
      proactive: { enabled: false }, sticker: { enabled: false },
      wake: { maxWakePerMinute: 0, maxWakePerHour: 0 },
    }, ...extra },
    files: { 'state/current-role.json': { role: 'Fixture', mode: 'active' }, 'roles/Fixture.md': CARD },
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const rewrite = card => fs.writeFileSync(path.join(h.temp, 'roles/Fixture.md'), card);
  const deliver = () => h.deliverPrompt(KEY, h.buildWakePromptV2(KEY, 'question'), { wakeReason: 'question', silent: true });
  try { await run({ h, st, rewrite, deliver }); }
  finally { await h.close(); }
}

test('preview construction does not consume role injection; ordinary wake actually delivers the full role', () => fixture(async ({ h, st }) => {
  assert.ok(h.buildWakePromptV2(KEY, 'question').includes(CARD));
  assert.ok(h.buildWakePromptV2(KEY, 'question').includes(CARD));
  assert.equal(st.roleCardHash, undefined);
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  assert.ok(textOf(h.calls.prompts[0]).includes(CARD));
  assert.equal(st.roleCardInjectedWake, st.wakeConfig.wakeCount);
  assert.ok(st.roleCardHash);
  assert.ok(!h.buildWakePromptV2(KEY, 'question').includes(CARD));
}));

test('changed role reaches the next actual prompt once; later ordinary prompts use the reference', () => fixture(async ({ h, rewrite, deliver }) => {
  await deliver();
  rewrite(UPDATED);
  assert.ok(h.buildWakePromptV2(KEY, 'question').includes(UPDATED));
  await deliver();
  assert.ok(textOf(h.calls.prompts.at(-1)).includes(UPDATED));
  await deliver();
  assert.ok(!textOf(h.calls.prompts.at(-1)).includes(UPDATED));
}));

test('periodic injection uses the existing wakeConfig count at the 20-wake boundary', () => fixture(async ({ h, st, deliver }) => {
  st.wakeConfig.wakeCount = 1;
  await deliver();
  st.wakeConfig.wakeCount = 20;
  await deliver();
  assert.ok(!textOf(h.calls.prompts.at(-1)).includes(CARD));
  st.wakeConfig.wakeCount = 21;
  await deliver();
  assert.ok(textOf(h.calls.prompts.at(-1)).includes(CARD));
  assert.equal(st.roleCardInjectedWake, 21);
  st.wakeConfig.wakeCount = 22;
  await deliver();
  assert.ok(!textOf(h.calls.prompts.at(-1)).includes(CARD));
}));

test('rejected and thrown deliveries do not consume the updated role', () => fixture(async ({ h, st, rewrite, deliver }) => {
  await deliver();
  const oldHash = st.roleCardHash;
  rewrite(UPDATED);
  const send = h.api.sessions.prompt;
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture', message: 'rejected' } } });
  assert.equal((await deliver()).ok, false);
  assert.equal(st.roleCardHash, oldHash);
  h.api.sessions.prompt = async () => { throw new Error('fixture disconnected'); };
  await assert.rejects(deliver(), /fixture disconnected/);
  assert.equal(st.roleCardHash, oldHash);
  h.api.sessions.prompt = send;
  await deliver();
  assert.ok(textOf(h.calls.prompts.at(-1)).includes(UPDATED));
  assert.notEqual(st.roleCardHash, oldHash);
}));

test('offline queue waits to consume the role and delivers the latest content on reconnect', () => fixture(async ({ h, st, rewrite }) => {
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(st.roleCardHash, undefined);
  rewrite(UPDATED);
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  assert.ok(textOf(h.calls.prompts[0]).includes(UPDATED));
  assert.ok(st.roleCardHash);
}));

test('acceptance records the role that was sent even if the file changes while in flight', () => fixture(async ({ h, st, rewrite, deliver }) => {
  let sentText = '';
  h.api.sessions.prompt = async prompt => {
    sentText = textOf(prompt);
    rewrite(UPDATED);
    return accepted();
  };
  await deliver();
  assert.ok(sentText.includes(CARD));
  assert.ok(st.roleCardHash);
  assert.ok(h.buildWakePromptV2(KEY, 'question').includes(UPDATED));
}));

test('acceptance for an old token or session cannot consume the current role', () => fixture(async ({ h, st, deliver }) => {
  const send = h.api.sessions.prompt;
  h.api.sessions.prompt = async () => { st.agentToken = 'fixture-rotated-token'; return accepted(); };
  await deliver();
  assert.equal(st.roleCardHash, undefined);
  h.api.sessions.prompt = async () => { h.retireSession(KEY); return accepted(); };
  await deliver();
  assert.equal(st.roleCardHash, undefined);
  h.api.sessions.prompt = send;
  await deliver();
  assert.ok(textOf(h.calls.prompts.at(-1)).includes(CARD));
}));

test('recreated DSH session receives the unchanged role on an ordinary wake', () => fixture(async ({ h, deliver }) => {
  await deliver();
  h.retireSession(KEY);
  await deliver();
  assert.equal(h.calls.created.length, 2);
  assert.ok(textOf(h.calls.prompts.at(-1)).includes(CARD));
}));

test('bridge restart supplies the current role to the retained DSH conversation without a reset', () => fixture(async ({ h, st, rewrite }) => {
  st.bootstrapSent = true;
  await h.sendWakePromptV2(KEY, 'question');
  rewrite(UPDATED);
  const restarted = await bridgeHarness({
    config: { role: { injectInV2Prompt: true }, socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } },
    savedState: JSON.parse(fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8')),
    files: {
      'state/mode.json': { mode: 'reserved2' },
      'state/current-role.json': { role: 'Fixture', mode: 'active' },
      'roles/Fixture.md': UPDATED,
      'state/social-v2.json': fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'),
    },
  });
  try {
    restarted.setMode('reserved2');
    await restarted.deliverPrompt(KEY, '', { wakeReason: 'question', silent: true });
    assert.equal(restarted.calls.created.length, 0);
    assert.equal(restarted.calls.prompts[0].sessionId, h.calls.prompts[0].sessionId);
    assert.ok(textOf(restarted.calls.prompts[0]).includes(UPDATED));
  } finally { await restarted.close(); }
}));

test('bootstrap continues to provide full role and opt-out remains effective', () => fixture(async ({ h, st, deliver }) => {
  await deliver();
  assert.ok(h.buildWakePromptV2(KEY, 'bootstrap').includes(CARD));
  h.cfg.role.injectInV2Prompt = false;
  const oldHash = st.roleCardHash;
  await h.deliverPrompt(KEY, '', { wakeReason: 'bootstrap', silent: true });
  assert.ok(!textOf(h.calls.prompts.at(-1)).includes(CARD));
  assert.equal(st.roleCardHash, oldHash);
}));

test('private conversational guidance is isolated from unchanged group guidance', () => fixture(async ({ h }) => {
  const privatePrompt = h.buildWakePromptV2(KEY, 'question');
  assert.ok(privatePrompt.includes('【私聊接话】'));
  assert.ok(privatePrompt.includes('不要求每轮提问'));
  assert.ok(privatePrompt.includes('旧情绪只作背景'));
  assert.ok(!privatePrompt.includes('可以装傻、已读乱回、拒绝推荐'));
  const groupPrompt = h.buildWakePromptV2('group:456', 'question');
  assert.ok(groupPrompt.includes('可以装傻、已读乱回、拒绝推荐'));
  assert.ok(groupPrompt.includes('群里有你能接的话题就主动参与'));
  assert.ok(!groupPrompt.includes('【私聊接话】'));
}));
