// Stale active topics are history, not current conversational instructions.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';
const NOW = 1800000000000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
class FixedDate extends Date { static now() { return NOW; } }

async function fixture(run) {
  const h = await bridgeHarness({ globals: { Date: FixedDate }, config: { socialV2: {
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  try { await run({ h, st }); }
  finally { await h.close(); }
}

test('old emotions stop appearing as current topics without deleting stored topics or unrelated memory', () => fixture(async ({ h, st }) => {
  st.activeTopics = [
    { text: 'old emotion waiting for apology', lastMentionAt: NOW - TWO_HOURS - 1, pendingQuestion: 'old unresolved question' },
    { text: 'current shared topic', lastMentionAt: NOW - 60000, pendingQuestion: 'current detail' },
  ];
  st.pendingThoughts = [{ text: 'fresh independent thought', expiresAt: NOW + 60000 }];
  st.memberImpressions = { fixture: { traits: ['likes reading'], interactionCount: 2 } };
  const stored = JSON.stringify(st.activeTopics);
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.ok(!prompt.includes('old emotion waiting for apology'));
  assert.ok(!prompt.includes('old unresolved question'));
  for (const text of ['current shared topic', 'current detail', 'fresh independent thought', 'likes reading']) assert.ok(prompt.includes(text));
  assert.equal(JSON.stringify(st.activeTopics), stored);
}));

test('existing two-hour boundary and undated-topic compatibility are preserved', () => fixture(async ({ h, st }) => {
  st.activeTopics = [
    { text: 'exactly two hours old', lastMentionAt: NOW - TWO_HOURS },
    { text: 'older than two hours', lastMentionAt: NOW - TWO_HOURS - 1 },
    { text: 'legacy undated topic' },
  ];
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.ok(prompt.includes('exactly two hours old'));
  assert.ok(!prompt.includes('older than two hours'));
  assert.ok(prompt.includes('legacy undated topic'));
  st.activeTopics[1].lastMentionAt = NOW;
  assert.ok(h.buildWakePromptV2(KEY, 'question').includes('older than two hours'));
}));

test('explicit memory query keeps old topic records available while its current-context view excludes them', () => fixture(async ({ h, st }) => {
  st.activeTopics = [{ text: 'old retrievable topic', lastMentionAt: NOW - TWO_HOURS - 1 }];
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/socialV2/memory?key=${KEY}&category=activeTopic`,
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
      }, response => {
        let text = '';
        response.on('data', part => { text += part; });
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
      });
      request.on('error', reject);
    });
    assert.equal(result.status, 200);
    assert.ok(JSON.stringify(result.data.raw).includes('old retrievable topic'));
    assert.ok(!result.data.formatted.includes('old retrievable topic'));
    assert.equal(st.activeTopics.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
