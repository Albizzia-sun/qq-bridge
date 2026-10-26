// Real bridge HTTP entry -> LocalVoice -> captured TTS request -> fake OneBot.
// No QQ connection or production configuration is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { serializeModelData } from '../src/qq-model-view.js';
import * as roleCard from '../src/role-card.js';
import { shouldReplyWithVoice } from '../src/local-voice.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-style-bridge-'));
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw).req_params);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: 0, data: Buffer.alloc(4800).toString('base64') }) + '\n' + JSON.stringify({ code: 20000000 }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const apiKeyFile = path.join(temp, 'key.txt');
fs.writeFileSync(apiKeyFile, 'fixture-key');
// Synthetic test data; public examples intentionally contain no prepared voice.
const styles = {
  version: 1, defaultStyle: 'daily',
  styles: {
    daily: { label: 'fixture daily', whenToUse: 'fixture daily scene', instruction: 'fixture synthesis instruction A' },
    comfort: { label: 'fixture comfort', whenToUse: 'fixture comfort scene', instruction: 'fixture synthesis instruction B' },
    explanation: { label: 'fixture explanation', whenToUse: 'fixture explanation scene', instruction: 'fixture synthesis instruction C' }
  }
};
const outputDir = path.join(temp, 'audio');
const voiceConfig = {
  styleConfigPath: 'voice-styles.json', outputDir,
  replyPolicy: { textVoiceProbability: 0.2, voiceVoiceProbability: 1 },
  tts: {
    provider: 'volcengine-icl-2.0', endpoint: `http://127.0.0.1:${server.address().port}`,
    apiKeyFile, resourceId: 'seed-icl-2.0', model: 'seed-tts-2.0-expressive', speaker: 'fixed-speaker',
    audioParams: { format: 'pcm', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 },
    additions: { max_length_to_filter_parenthesis: 0, context_texts: ['old fixed instruction'] }
  }
};
let h;
let consoleServer;
try {
  h = await bridgeHarness({
    config: {
      localVoice: { enabled: true, configPath: 'voice/voice-config.json' },
      socialV2: { voice: { enabled: true, dir: outputDir, maxPerMinute: 100 }, tools: { sendVoice: true }, sticker: { enabled: false } }
    },
    files: { 'voice/voice-config.json': voiceConfig, 'voice/voice-styles.json': styles },
    globals: { ...roleCard, shouldReplyWithVoice: (...args) => shouldReplyWithVoice(...args, () => 0.5) }
  });
  h.setMode('reserved2');
  h.bot.getMessage = async () => ({ group_id: 456, user_id: 123, sender: { nickname: 'fixture', user_id: 123 }, message: [{ type: 'record', data: { file: 'fixture.amr' } }] });
  const states = {};
  for (const key of ['private:123', 'group:456']) {
    const st = h.getSocialV2State(key);
    const message = { seq: 1, messageId: '101', isVoice: true, isSelf: false, text: '你好', sender: 'fixture', userId: '123' };
    st.unread = [message]; st.recentMessages = [message]; st.lastUnreadSeq = 1;
    h.noteModelMessagesV2(st, [message]);
    states[key] = st;
  }
  consoleServer = h.startConsoleServer(h.cfg);
  if (!consoleServer.listening) await once(consoleServer, 'listening');
  const baseUrl = `http://127.0.0.1:${consoleServer.address().port}`;
  const send = async (route, body, key = 'private:123') => {
    const response = await fetch(baseUrl + route, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': states[key].agentToken },
      body: JSON.stringify({ ...body, token: states[key].agentToken })
    });
    return { status: response.status, body: await response.json() };
  };
  const response = await fetch(baseUrl + '/api/socialV2/prompt?key=private%3A123', { headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': states['private:123'].agentToken } });
  const prompt = JSON.parse(serializeModelData(await response.json()));
  assert.equal(response.status, 200, JSON.stringify(prompt));
  assert.equal(prompt.voiceStyles?.defaultStyle, 'daily', 'qq_get_prompt must expose the loaded style selection rules');
  assert.deepEqual(Object.keys(prompt.voiceStyles.styles).sort(), ['comfort', 'daily', 'explanation']);
  assert.equal(prompt.voiceStyles.styles.comfort.whenToUse, styles.styles.comfort.whenToUse);
  assert.ok(!JSON.stringify(prompt.voiceStyles).includes('fixture-key'));
  assert.ok(!JSON.stringify(prompt.voiceStyles).includes(styles.styles.comfort.instruction), 'full synthesis instructions stay in the trusted voice module');
  const wakePrompt = h.buildWakePromptV2('private:123', 'message');
  assert.match(wakePrompt, /voiceStyle/);
  assert.ok(wakePrompt.includes(styles.styles.comfort.whenToUse), 'existing sessions see style guidance on their next wake');

  const entries = [
    ['/api/socialV2/send-message', { key: 'private:123', messages: ['自然接话。'], voiceStyle: 'daily' }, 'private:123', 'daily'],
    ['/api/socialV2/send-message', { key: 'private:123', messages: ['我在听。', '慢慢说。'], gaps: [0], gapMode: 'fixed', voiceStyle: 'comfort' }, 'private:123', 'comfort'],
    ['/api/socialV2/send-message', { key: 'private:123', messages: ['先等一会儿。'], voiceStyle: 'explanation' }, 'private:123', 'explanation'],
    ['/api/socialV2/send-message', { key: 'private:123', messages: ['未选择时用默认。'] }, 'private:123', 'daily'],
    ['/api/send/private', { userId: '123', message: '私聊安慰。', voiceStyle: 'comfort' }, 'private:123', 'comfort'],
    ['/api/send/group', { groupId: '456', message: '群聊解释。', voiceStyle: 'explanation' }, 'group:456', 'explanation'],
    ['/api/send/reply', { groupId: '456', replyToMessageId: '101', message: '引用安慰。', voiceStyle: 'comfort' }, 'group:456', 'comfort'],
    ['/api/socialV2/send-burst', { key: 'group:456', messages: ['分条说明。'], voiceStyle: 'explanation' }, 'group:456', 'explanation']
  ];
  for (const [route, body, key, expectedStyle] of entries) {
    const before = requests.length;
    const result = await send(route, body, key);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.sent, Array.isArray(body.messages) ? body.messages.length : 1);
    const sentTexts = body.messages || [body.message];
    assert.deepEqual(requests.slice(before).map(r => r.text), sentTexts);
    for (const request of requests.slice(before)) {
      assert.equal(request.speaker, voiceConfig.tts.speaker);
      assert.equal(request.model, voiceConfig.tts.model);
      assert.deepEqual(request.audio_params, voiceConfig.tts.audioParams);
      assert.deepEqual(JSON.parse(request.additions), { max_length_to_filter_parenthesis: 0, context_texts: [styles.styles[expectedStyle].instruction] });
    }
  }
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_private_msg') || c.url.endsWith('/send_group_msg')).filter(c => c.body.message.some(s => s.type === 'record')).length, requests.length);
  for (const [route, body, key] of entries) {
    const before = requests.length;
    const beforeQuota = states[key].sendTimes.length;
    const result = await send(route, { ...body, voiceStyle: 'arbitrary-instruction' }, key);
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal(requests.length, before, 'invalid style must not synthesize or send');
    assert.equal(states[key].sendTimes.length, beforeQuota, 'invalid style must not consume the send quota');
  }
  const textMessage = { seq: states['private:123'].lastUnreadSeq + 1, messageId: '102', isVoice: false, isSelf: false, text: '文字输入' };
  states['private:123'].unread.push(textMessage);
  h.noteModelMessagesV2(states['private:123'], [textMessage]);
  const beforeText = requests.length;
  const textResult = await send('/api/socialV2/send-message', { key: 'private:123', messages: '继续文字回复。', voiceStyle: 'comfort' });
  assert.equal(textResult.status, 200);
  assert.equal(requests.length, beforeText, 'style must not force a voice reply over the existing 20% policy');
  assert.equal(h.calls.http.filter(c => c.url.endsWith('/send_private_msg')).at(-1).body.message[0].type, 'text');
  assert.deepEqual(fs.readdirSync(outputDir), [], 'the normal send path must clean generated WAVs');
  console.log('PASS: 5 HTTP send routes, 3 styles/default, model guidance, batch consistency, validation, unchanged voice probabilities and parameters');
} finally {
  if (consoleServer) await new Promise(resolve => consoleServer.close(resolve));
  if (h) await h.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
