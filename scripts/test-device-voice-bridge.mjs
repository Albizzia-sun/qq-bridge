// Real console handlers against temporary files and fake DSH / OneBot only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('真实bridge HTTP入口复用原session；设备正式输出无QQ副作用，下一QQ turn正常发送', { timeout: 10000 }, async () => {
  const h = await bridgeHarness({
    config: { deviceVoice: { sharedKeys: ['private:123'] }, localVoice: { enabled: true, configPath: 'voice.json' } }, files: { 'voice.json': {} },
    globals: { LocalVoice: class {
      config = { replyPolicy: { textVoiceProbability: 0, voiceVoiceProbability: 0 } };
      getVoiceStyleGuidance() { return { defaultStyle: 'daily' }; }
      validateVoiceStyle(style) { if (style !== undefined && !['daily', 'comfort', 'explanation'].includes(style)) throw new Error('invalid style'); }
      async synthesize() { assert.fail('bridge must not synthesize device output'); }
    } }
  });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'private:123';
    const sid = await h.ensureSession(key);
    const state = h.getSocialV2State(key);
    const oldToken = state.agentToken;
    let seq = 0;
    const emit = (type, data) => h.deviceVoice.observe(sid, { type, data, seq: ++seq });
    h.deviceVoice.snapshot(sid, { records: [{ type: 'turn/end', seq: 0, data: { reason: { kind: 'completed' } } }], projections: { asOfSeq: 0 } });
    h.api.callUnary = async method => {
      assert.equal(method, 'session/projections');
      return { result: { ok: true, value: { asOfSeq: seq, values: {} } } };
    };
    let submitted;
    const admitted = new Promise(resolve => { submitted = resolve; });
    h.api.sessions.prompt = async params => { h.calls.prompts.push(params); submitted(params); return { result: { ok: true, value: { accepted: true } } }; };
    server = h.startConsoleServer();
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, body, token, agent = false) => {
      const response = await fetch(base + route, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
        headers: { 'x-console-token': 'fixture-console-token', ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { 'x-agent-token': token } : {}), ...(agent ? { 'x-agent-call': '1' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/api/device/ready?key=private%3A123')).status, 200);
    h.cfg.deviceVoice.sharedKeys = [];
    assert.equal((await request('/api/device/ready?key=private%3A123')).status, 409, 'ready must require explicit shared configuration');
    h.cfg.deviceVoice.sharedKeys = ['private:123'];
    const recording = request('/api/device/prompt', { key, transcript: '从设备说的话', requestId: 'untrusted-request-id' });
    recording.catch(() => {});
    const prompt = await admitted;
    assert.equal(prompt.sessionId, sid);
    assert.equal(prompt.mode, 'queue');
    assert.match(prompt.requestId, /^esp32-voice:/);
    assert.ok(prompt.content[0].text.includes('从设备说的话'));
    assert.equal(h.calls.created.length, 1, 'device must not create another session');

    // An existing QQ turn still owns its normal reply even while device is queued.
    emit('turn/start', { turn: 1 });
    emit('user/message', { source: { kind: 'user', rpcId: 'qq-first' } });
    emit('tool/call', { name: 'mcp__snowluma__qq_send_message', callId: 'qq-call', arguments: { key, token: oldToken, messages: ['QQ先答'] } });
    const sentCount = () => h.calls.sent.length + h.calls.http.filter(call => /\/send_(private|group)_msg$/.test(call.url)).length;
    const beforeQQ = sentCount();
    assert.equal((await request('/api/socialV2/send-message', { key, messages: ['QQ先答'] }, oldToken, true)).status, 200);
    assert.equal(sentCount(), beforeQQ + 1);
    emit('turn/end', { reason: { kind: 'completed' } });

    emit('turn/start', { turn: 2 });
    emit('user/message', { source: { kind: 'user', rpcId: prompt.requestId } });
    const beforeDevice = sentCount();
    const beforeTimes = state.sendTimes.length;
    const messages = ['设备回答'];
    emit('tool/call', { name: 'mcp__snowluma__qq_send_message', callId: 'device-call', arguments: JSON.stringify({ key, token: oldToken, messages, voiceStyle: 'comfort' }) });
    // Even the old persistent QQ token must follow actual turn origin.
    const send = await request('/api/socialV2/send-message', { key, messages, voiceStyle: 'comfort' }, oldToken, true);
    assert.equal(send.status, 200, JSON.stringify(send));
    assert.equal(send.body.channel, 'device');
    assert.equal(send.body.sent, 0);
    assert.equal(sentCount(), beforeDevice);
    assert.equal(state.sendTimes.length, beforeTimes, 'device must not consume QQ send quota');
    for (const [route, body, token] of [
      ['/api/send/private', { userId: 123, message: '禁止旧发送', token: oldToken }, oldToken],
      ['/api/send/private', { userId: 123, message: '禁止无令牌发送' }, null],
      ['/api/socialV2/send-poke', { key, targetUserId: 123 }, oldToken],
      ['/api/socialV2/send-voice', { key, voice: 'fake.wav' }, oldToken],
      ['/api/socialV2/send-sticker', { key, stickerId: 'fake' }, oldToken],
      ['/api/socialV2/wait', { key, timeoutMs: 300000 }, oldToken],
      ['/api/socialV2/wake-config', { key, config: {} }, oldToken],
    ]) assert.equal((await request(route, body, token, true)).status, 403, route);
    assert.equal(sentCount(), beforeDevice);
    emit('tool/result', { message: { source: { callId: 'device-call' }, content: [{ type: 'text', text: JSON.stringify(send.body) }] } });
    emit('tool/call', { name: 'mcp__snowluma__qq_send_message', callId: 'late-device-call', arguments: { key, token: oldToken, messages: ['迟到设备'] } });
    emit('turn/end', { reason: { kind: 'completed' } });
    const result = await recording;
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body.reply, { segments: [{ text: '设备回答', voiceStyle: 'comfort' }] });

    emit('turn/start', { turn: 3 });
    emit('user/message', { source: { kind: 'user', rpcId: 'qq-after' } });
    const late = await request('/api/socialV2/send-message', { key, messages: ['迟到设备'] }, oldToken, true);
    assert.notEqual(late.status, 200);
    assert.equal(sentCount(), beforeDevice, 'late device HTTP must never fall through to QQ');
    emit('tool/call', { name: 'mcp__snowluma__qq_send_message', callId: 'qq-next-call', arguments: { key, token: oldToken, messages: ['QQ继续'] } });
    assert.equal((await request('/api/socialV2/send-message', { key, messages: ['QQ继续'] }, oldToken, true)).status, 200);
    assert.equal(sentCount(), beforeDevice + 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});
