import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { LocalVoice, noteVoiceReplySource, shouldReplyWithVoice } from '../src/local-voice.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { serializeModelData } from '../src/qq-model-view.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-voice-test-'));
const wav = Buffer.alloc(100);
wav.write('RIFF'); wav.writeUInt32LE(92, 4); wav.write('WAVE', 8);
const requests = [];
let failTts = false;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  requests.push({ url: req.url, body });
  if (req.url === '/get_record') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {
      file: 'https://qq.example/fresh-download', url: 'https://qq.example/fresh-download',
      file_size: String(wav.length), file_name: 'voice.amr', out_format: 'wav', base64: wav.toString('base64')
    } }));
  } else if (req.url === '/tts') {
    if (failTts) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"model failed"}'); }
    else { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); }
  } else { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const commands = [];
const config = {
  asr: { executable: 'whisper-cli', model: 'small.bin', ffmpeg: 'ffmpeg', language: 'zh', threads: 8 },
  tts: { baseUrl, referenceAudio: 'reference.wav', referenceText: '固定参考文字', parameters: { seed: 20261022, speed_factor: 1 } },
  workDir: path.join(temp, 'work'), outputDir: path.join(temp, 'audio')
};
const voice = new LocalVoice(config, { runFile: async (exe, args) => {
  commands.push({ exe, args });
  if (exe === 'whisper-cli') fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.txt`, ' 今天天气不错。\n');
} });
try {
  const replyPolicy = { textVoiceProbability: 0.2, voiceVoiceProbability: 1 };
  const textSource = { localVoiceReplySource: { isVoice: false } };
  const voiceSource = { localVoiceReplySource: { isVoice: true } };
  const noRandom = () => { throw new Error('a certain reply format must not sample randomness'); };
  assert.equal(shouldReplyWithVoice(textSource, null, null, replyPolicy, () => 0.199999), true, 'text uses voice below the saved 20% boundary');
  assert.equal(shouldReplyWithVoice(textSource, null, null, replyPolicy, () => 0.2), false, 'text stays text at the 20% boundary');
  assert.equal(shouldReplyWithVoice(voiceSource, null, null, replyPolicy, noRandom), true, 'voice replies remain 100% voice without drawing randomness');
  assert.equal(shouldReplyWithVoice(textSource, null, null, undefined, noRandom), false, 'an absent policy preserves text-only replies');
  assert.equal(shouldReplyWithVoice(voiceSource, null, null, undefined, noRandom), true, 'an absent policy preserves voice replies');
  assert.equal(shouldReplyWithVoice({}, null, null, replyPolicy, noRandom), false, 'no incoming source must not enable proactive voice');
  assert.equal(shouldReplyWithVoice(textSource, 'missing', null, replyPolicy, noRandom), false, 'an unknown quote must not inherit the current source');
  assert.equal(shouldReplyWithVoice(textSource, 'self', { isVoice: false, isSelf: true }, replyPolicy, noRandom), false, 'a self-quoted text must not use the text voice probability');
  assert.equal(shouldReplyWithVoice(textSource, 'self', { isVoice: true, isSelf: true }, replyPolicy, noRandom), false, 'a self-quoted voice must not trigger a voice reply');
  assert.equal(shouldReplyWithVoice(voiceSource, 'text', { isVoice: false, isSelf: false }, replyPolicy, () => 0.2), false, 'an explicitly quoted text uses its own source type');
  const policyConfig = { ...config, replyPolicy: { ...replyPolicy } };
  const policyVoice = new LocalVoice(policyConfig);
  policyConfig.replyPolicy.textVoiceProbability = 1;
  policyConfig.replyPolicy.voiceVoiceProbability = 0;
  assert.deepEqual(policyVoice.config.replyPolicy, replyPolicy, 'reply probabilities are a startup snapshot');
  for (const field of ['textVoiceProbability', 'voiceVoiceProbability']) {
    for (const invalid of [-0.1, 1.1, NaN, Infinity, '0.2', null]) {
      assert.throws(() => new LocalVoice({ ...config, replyPolicy: { ...replyPolicy, [field]: invalid } }), new RegExp(field), `${field} rejects ${String(invalid)}`);
    }
  }

  const input = [{ type: 'text', data: { text: '前缀' } }, { type: 'record', data: { file: 'old.amr', url: 'https://qq.example/expired' } }];
  const result = await voice.transcribeSegments(input, { httpUrl: baseUrl });
  assert.equal(result.isVoice, true);
  assert.equal(result.segments[1].data.text, '[语音转写] 今天天气不错。');
  assert.equal(input[1].type, 'record');
  assert.deepEqual(requests.map(r => r.body), [{ file: 'old.amr', out_format: 'wav' }]);
  assert.equal(commands[0].exe, 'ffmpeg');
  assert.equal(commands[1].args[commands[1].args.indexOf('-t') + 1], '8');
  assert.deepEqual(fs.readdirSync(config.workDir), []);
  const before = requests.length;
  const plain = [{ type: 'text', data: { text: '普通文字' } }];
  assert.deepEqual(await voice.transcribeSegments(plain, { httpUrl: baseUrl }), { segments: plain, isVoice: false });
  assert.equal(requests.length, before);
  const output = await voice.synthesize('你好。');
  assert.ok(fs.readFileSync(output).equals(wav));
  const payload = requests.at(-1).body;
  assert.equal(payload.text, '你好。');
  assert.equal(payload.ref_audio_path, 'reference.wav');
  assert.equal(payload.prompt_text, '固定参考文字');
  assert.equal(payload.seed, 20261022);
  assert.equal(payload.media_type, 'wav');
  assert.equal(payload.streaming_mode, false);
  config.tts.parameters.seed = 999;
  await voice.synthesize('参数不漂移。');
  assert.equal(requests.at(-1).body.seed, 20261022);
  const indexVoice = new LocalVoice({ ...config, tts: { ...config.tts, provider: 'indextts-2.5' } });
  await indexVoice.synthesize('使用已保存的试听音色。');
  assert.deepEqual(requests.at(-1).body, { text: '使用已保存的试听音色。' }, 'IndexTTS must receive only text; the service owns the fixed voice and parameters');
  failTts = true;
  await assert.rejects(voice.synthesize('不能伪成功。'), /TTS.*500/);
  const failedAsr = new LocalVoice(config, { runFile: async () => { throw new Error('ASR process failed'); } });
  await assert.rejects(failedAsr.transcribeSegments(input, { httpUrl: baseUrl }), /ASR process failed/);
  assert.deepEqual(fs.readdirSync(config.workDir), []);

  const cloudKeyFile = path.join(temp, 'asr-key.txt');
  fs.writeFileSync(cloudKeyFile, 'fixture-asr-key');
  const cloudConfig = { ...config, asr: {
    provider: 'volcengine-asr-2.0', apiKeyFile: cloudKeyFile,
    endpoint: 'ws://127.0.0.1:1', resourceId: 'volc.seedasr.sauc.duration',
    ffmpeg: 'ffmpeg', audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, result_type: 'full' },
    chunkDurationMs: 200, timeoutMs: 180000
  } };
  const pcm = Buffer.from([0, 0, 1, 0, 255, 127]);
  const cloudCommands = [];
  const cloudRunFile = async (exe, args) => {
    cloudCommands.push({ exe, args });
    assert.equal(exe, 'ffmpeg', 'cloud ASR must not launch Whisper');
    assert.ok(fs.readFileSync(args[args.indexOf('-i') + 1]).equals(wav));
    assert.equal(args[args.indexOf('-ar') + 1], '16000');
    assert.equal(args[args.indexOf('-ac') + 1], '1');
    assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
    assert.equal(args[args.indexOf('-f') + 1], 's16le', 'cloud ASR receives raw PCM, not a WAV header');
    fs.writeFileSync(args.at(-1), pcm);
  };
  const cloudVoice = new LocalVoice(cloudConfig, { runFile: cloudRunFile });
  assert.ok(cloudVoice.cloudAsr, 'configured cloud ASR must be selected');
  let cloudAsrCalls = 0;
  const recognizeCloud = async bytes => {
    cloudAsrCalls += 1;
    assert.ok(bytes.equals(pcm));
    return '豆包识别的语音。';
  };
  cloudVoice.cloudAsr.transcribe = recognizeCloud;
  const cloudResult = await cloudVoice.transcribeSegments(input, { httpUrl: baseUrl });
  assert.equal(cloudResult.isVoice, true);
  assert.equal(cloudResult.segments[1].data.text, '[语音转写] 豆包识别的语音。');
  assert.equal(cloudAsrCalls, 1);
  assert.deepEqual(fs.readdirSync(config.workDir), []);
  await cloudVoice.transcribeSegments(plain, { httpUrl: baseUrl });
  assert.equal(cloudAsrCalls, 1, 'text messages must not use cloud ASR');
  cloudVoice.cloudAsr.transcribe = async () => { throw new Error('cloud ASR rejected'); };
  await assert.rejects(cloudVoice.transcribeSegments(input, { httpUrl: baseUrl }), /cloud ASR rejected/);
  assert.equal(cloudCommands.length, 2, 'an ASR error must not trigger a retry or local fallback');
  assert.deepEqual(fs.readdirSync(config.workDir), [], 'failed cloud ASR must clean its temporary audio');

  const incomingVoice = { seq: 1, messageId: '101', isVoice: true, isSelf: false };
  const incomingText = { seq: 2, messageId: '102', isVoice: false, isSelf: false };
  const st = { unread: [incomingVoice, incomingText], recentMessages: [incomingVoice, incomingText] };
  noteVoiceReplySource(st, [incomingVoice]);
  assert.equal(shouldReplyWithVoice(st), true, 'unseen newer text must not alter the current reply');
  assert.equal(shouldReplyWithVoice(st, null, null, replyPolicy, noRandom), true, 'probability routing keeps unread text from changing a voice reply');
  noteVoiceReplySource(st, [incomingText]);
  assert.equal(shouldReplyWithVoice(st), false, 'text input must clear voice reply mode');
  noteVoiceReplySource(st, [incomingVoice]);
  assert.equal(shouldReplyWithVoice(st), false, 'reading older history must not restore an old voice mode');
  assert.equal(shouldReplyWithVoice(st, null, null, replyPolicy, () => 0.2), false, 'probability routing retains the newest model-visible source');
  assert.equal(shouldReplyWithVoice(st, '101'), true);
  assert.equal(shouldReplyWithVoice(st, '102'), false);
  assert.equal(shouldReplyWithVoice(st, '999'), false);
  const historyOnly = { unread: [], recentMessages: [incomingVoice] };
  noteVoiceReplySource(historyOnly, [incomingVoice]);
  assert.equal(shouldReplyWithVoice(historyOnly), false, 'historical voice must not change a later proactive message');

  failTts = false;
  const cloudBridge = await bridgeHarness({
    config: {
      snowluma: { httpUrl: baseUrl },
      localVoice: { enabled: true, configPath: 'voice.json' },
      socialV2: { voice: { enabled: true, dir: config.outputDir }, tools: { sendVoice: true } }
    },
    files: { 'voice.json': cloudConfig },
    globals: { LocalVoice: class extends LocalVoice {
      constructor(settings) {
        super(settings, { runFile: cloudRunFile });
        this.cloudAsr.transcribe = recognizeCloud;
      }
    } }
  });
  try {
    cloudBridge.setMode('reserved2');
    cloudBridge.socialV2.paused = true;
    const event = { self_id: 999, user_id: 123, message_id: 401, message: [{ type: 'record', data: { file: 'cloud.amr' } }] };
    await cloudBridge.handleIncoming('private', 123, event, cloudBridge.cfg);
    const state = cloudBridge.getSocialV2State('private:123');
    assert.equal(state.unread.at(-1).text, '[语音转写] 豆包识别的语音。');
    cloudBridge.noteModelMessagesV2(state, state.unread);
    await cloudBridge.sendMessagesV2('private:123', ['收到语音。'], []);
    assert.equal(cloudBridge.calls.http.filter(c => c.url.endsWith('/send_private_msg')).at(-1).body.message[0].type, 'record');
    const beforeText = cloudAsrCalls;
    const ttsBeforeText = requests.filter(r => r.url === '/tts').length;
    await cloudBridge.handleIncoming('private', 123, { ...event, message_id: 402, message: plain }, cloudBridge.cfg);
    cloudBridge.noteModelMessagesV2(state, state.unread);
    await cloudBridge.sendMessagesV2('private:123', ['收到文字。'], []);
    assert.equal(cloudAsrCalls, beforeText);
    assert.equal(requests.filter(r => r.url === '/tts').length, ttsBeforeText);
    assert.equal(cloudBridge.calls.http.filter(c => c.url.endsWith('/send_private_msg')).at(-1).body.message[0].type, 'text');
  } finally { await cloudBridge.close(); }

  const bridgeConfig = { ...config, tts: { ...config.tts, provider: 'indextts-2.5' } };
  let synthCount = 0;
  let releaseAsr;
  let markAsrStarted;
  const asrStarted = new Promise(resolve => { markAsrStarted = resolve; });
  const asrGate = new Promise(resolve => { releaseAsr = resolve; });
  const h = await bridgeHarness({
    config: {
      snowluma: { httpUrl: baseUrl },
      localVoice: { enabled: true, configPath: 'voice.json' },
      socialV2: { voice: { enabled: true, dir: config.outputDir }, tools: { sendVoice: true } }
    },
    files: { 'voice.json': bridgeConfig },
    globals: { LocalVoice: class extends LocalVoice {
      constructor(settings) { super(settings, { runFile: voice.runFile }); }
      async synthesize(text) { synthCount += 1; return super.synthesize(text); }
      async transcribeSegments(segments, gateway) {
        if (segments.some(segment => segment.data?.file === 'slow.amr')) {
          markAsrStarted();
          await asrGate;
        }
        return super.transcribeSegments(segments, gateway);
      }
    } }
  });
  try {
    h.setMode('reserved2');
    h.socialV2.paused = true; // fixture controls dispatch explicitly; no timer-driven fake model turns
    const event = { self_id: 999, user_id: 123, message_id: 501, sender: { nickname: 'fixture' }, message: [{ type: 'record', data: { file: 'first.amr' } }] };
    await h.handleIncoming('private', 123, event, h.cfg);
    const state = h.getSocialV2State('private:123');
    assert.equal(state.unread.at(-1).isVoice, true);
    assert.match(state.unread.at(-1).text, /今天天气不错/);
    const wakeVoice = h.buildWakeSnapshotV2('private:123').messages.find(message => message.messageId === '501');
    assert.equal(wakeVoice.text, '[语音转写] 今天天气不错。', 'the model wake snapshot must distinguish recognized speech from an unavailable audio placeholder');
    assert.equal(wakeVoice.isVoice, true);
    h.noteModelMessagesV2(state, state.unread);
    const sent = await Promise.race([
      h.sendMessagesV2('private:123', ['确实不错。'], []),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('sendChain deadlock')), 3000); timer.unref(); })
    ]);
    assert.equal(sent.length, 1);
    assert.equal(synthCount, 1);
    assert.deepEqual(requests.filter(request => request.url === '/tts').at(-1).body, { text: '确实不错。' }, 'the actual bridge voice reply must use the fixed IndexTTS service contract');
    const voiceSend = h.calls.http.find(call => call.url.endsWith('/send_private_msg'));
    assert.equal(voiceSend.body.message[0].type, 'record');
    assert.ok(!fs.existsSync(voiceSend.body.message[0].data.file), 'generated reply file is cleaned after send');
    assert.ok(h.calls.http.some(call => call.url.endsWith('/get_msg')), 'existing record verification remains active');
    await h.handleIncoming('private', 123, { ...event, message_id: 502, message: [{ type: 'text', data: { text: '这条是文字。' } }] }, h.cfg);
    h.noteModelMessagesV2(state, state.unread);
    await h.sendMessagesV2('private:123', ['文字照常。'], []);
    assert.equal(synthCount, 1, 'text input must not call TTS');
    assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).at(-1).body.message[0].type, 'text');
    h.cfg.socialV2.tools.sendVoice = false;
    await assert.rejects(h.sendMessagesV2('private:123', ['不绕过语音权限。'], [], '501'), /工具未启用/);
    assert.equal(synthCount, 1, 'disabled voice tool must block before synthesis');
    h.cfg.socialV2.tools.sendVoice = true;
    failTts = true;
    const sendsBefore = h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).length;
    await assert.rejects(h.sendMessagesV2('private:123', ['失败不伪成功。'], [], '501'), /TTS/);
    assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).length, sendsBefore, 'TTS failure must not send text instead');
    failTts = false;
    const pendingVoice = h.handleIncoming('private', 123, { ...event, message_id: 503, message: [{ type: 'record', data: { file: 'slow.amr' } }] }, h.cfg);
    await asrStarted;
    await h.handleIncoming('private', 123, { ...event, message_id: 504, message: [{ type: 'text', data: { text: '后到的文字。' } }] }, h.cfg);
    releaseAsr();
    await pendingVoice;
    assert.deepEqual(Array.from(state.unread.slice(-2), message => message.messageId), ['504', '503'], 'ASR must not serialize the existing event handlers');
    h.noteModelMessagesV2(state, state.unread);
    assert.equal(shouldReplyWithVoice(state), false, 'later text arrival must win even when earlier voice ASR completes last');
    assert.equal(shouldReplyWithVoice(state, null, null, replyPolicy, () => 0.2), false, 'probability routing must also retain arrival order after slow ASR');
    const synthBeforeTextReply = synthCount;
    await h.sendMessagesV2('private:123', ['按最后到达的文字回复。'], []);
    assert.equal(synthCount, synthBeforeTextReply);
    assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).at(-1).body.message[0].type, 'text');
    let historicalLookups = 0;
    h.bot.getMessage = async (messageId) => {
      historicalLookups += 1;
      assert.equal(messageId, 700);
      return { message_id: 700, user_id: 123, sender: { user_id: 123, nickname: 'fixture' }, message: [{ type: 'record', data: { file: 'historical.amr' } }] };
    };
    h.socialV2.paused = false;
    const consoleServer = h.startConsoleServer();
    try {
      if (!consoleServer.listening) await once(consoleServer, 'listening');
      const unreadResponse = await fetch(`http://127.0.0.1:${consoleServer.address().port}/api/socialV2/unread?key=private%3A123`, {
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': state.agentToken }
      });
      assert.equal(unreadResponse.status, 200);
      const unreadForModel = JSON.parse(serializeModelData(await unreadResponse.json()));
      const toolVoice = unreadForModel.messages.find(message => message.messageId === '501');
      assert.equal(toolVoice.text, '[语音转写] 今天天气不错。', 'the model tool result must preserve the explicit transcript marker');
      assert.equal(toolVoice.isVoice, true);
      const response = await fetch(`http://127.0.0.1:${consoleServer.address().port}/api/socialV2/send-message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': state.agentToken },
        body: JSON.stringify({ key: 'private:123', messages: ['回复这条历史语音。'], replyToMessageId: 700 })
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(historicalLookups, 1, 'reply routing must reuse the existing resolved message');
      const segments = h.calls.http.filter(call => call.url.endsWith('/send_private_msg')).at(-1).body.message;
      assert.deepEqual(Array.from(segments, segment => segment.type), ['reply', 'record'], 'quoted historical voice must retain its input type after leaving recentMessages');
    } finally { await new Promise(resolve => consoleServer.close(resolve)); }
  } finally { await h.close(); }

  const samples = [0.199999, 0.2];
  let randomCalls = 0;
  const probabilityBridge = await bridgeHarness({
    config: {
      snowluma: { httpUrl: baseUrl },
      localVoice: { enabled: true, configPath: 'voice.json' },
      socialV2: { voice: { enabled: true, dir: config.outputDir, maxPerMinute: 3 }, tools: { sendVoice: true } }
    },
    files: { 'voice.json': { ...bridgeConfig, replyPolicy } },
    globals: {
      LocalVoice: class extends LocalVoice {
        constructor(settings) { super(settings, { runFile: voice.runFile }); }
      },
      shouldReplyWithVoice: (state, replyTo, resolved, policy) => shouldReplyWithVoice(state, replyTo, resolved, policy, () => {
        randomCalls += 1;
        assert.ok(samples.length > 0, 'the bridge must sample only once per reply batch');
        return samples.shift();
      })
    }
  });
  try {
    probabilityBridge.setMode('reserved2');
    probabilityBridge.socialV2.paused = true;
    const textEvent = { self_id: 999, user_id: 123, message_id: 601, message: plain };
    await probabilityBridge.handleIncoming('private', 123, textEvent, probabilityBridge.cfg);
    const state = probabilityBridge.getSocialV2State('private:123');
    probabilityBridge.noteModelMessagesV2(state, state.unread);
    const ttsBefore = requests.filter(request => request.url === '/tts').length;
    await probabilityBridge.sendMessagesV2('private:123', ['文字抽中语音第一条。', '文字抽中语音第二条。'], []);
    let sends = probabilityBridge.calls.http.filter(call => call.url.endsWith('/send_private_msg'));
    assert.deepEqual(sends.map(call => call.body.message[0].type), ['record', 'record'], 'the actual bridge must route a sampled text reply batch to voice');
    assert.equal(randomCalls, 1, 'a two-message voice batch draws only once');
    assert.deepEqual(requests.filter(request => request.url === '/tts').slice(ttsBefore).map(request => request.body), [
      { text: '文字抽中语音第一条。' }, { text: '文字抽中语音第二条。' }
    ], 'probability routing must preserve the fixed TTS text-only request contract');
    await probabilityBridge.sendMessagesV2('private:123', ['文字未抽中第一条。', '文字未抽中第二条。'], []);
    sends = probabilityBridge.calls.http.filter(call => call.url.endsWith('/send_private_msg'));
    assert.deepEqual(sends.slice(-2).map(call => call.body.message[0].type), ['text', 'text']);
    assert.equal(randomCalls, 2, 'the next batch gets its own single draw');
    assert.equal(requests.filter(request => request.url === '/tts').length, ttsBefore + 2, 'an unsampled text reply never calls TTS');
    await probabilityBridge.handleIncoming('private', 123, { ...textEvent, message_id: 602, message: [{ type: 'record', data: { file: 'always-voice.amr' } }] }, probabilityBridge.cfg);
    probabilityBridge.noteModelMessagesV2(state, state.unread);
    await probabilityBridge.sendMessagesV2('private:123', ['语音始终使用语音。'], []);
    sends = probabilityBridge.calls.http.filter(call => call.url.endsWith('/send_private_msg'));
    assert.equal(sends.at(-1).body.message[0].type, 'record');
    assert.equal(randomCalls, 2, 'a 100% voice reply does not draw randomness');
  } finally { await probabilityBridge.close(); }

  const savedVoice = { seq: 20, messageId: '800', receivedOrder: 4_000_000_000_000, isVoice: true, isSelf: false, text: '[语音] 重启前的消息' };
  const restarted = await bridgeHarness({
    config: { localVoice: { enabled: true, configPath: 'voice.json' } },
    files: {
      'voice.json': bridgeConfig,
      'state/social-v2.json': { paused: true, conversations: { 'private:123': { unread: [savedVoice], recentMessages: [savedVoice], lastUnreadSeq: 20 } } }
    }
  });
  try {
    restarted.setMode('reserved2');
    await restarted.handleIncoming('private', 123, { user_id: 123, message_id: 801, message: [{ type: 'text', data: { text: '重启后新收到的文字。' } }] }, restarted.cfg);
    const state = restarted.getSocialV2State('private:123');
    restarted.noteModelMessagesV2(state, state.unread);
    assert.equal(shouldReplyWithVoice(state), false, 'restored arrival watermark must not override a new text input after restart');
    assert.equal(shouldReplyWithVoice(state, null, null, replyPolicy, () => 0.2), false, 'probability routing must preserve restored arrival ordering');
  } finally { await restarted.close(); }
  console.log('local voice: ASR HTTP + subprocess contract, fixed TTS, failures, reply-source ordering, and 20%/100% batch routing passed');
} finally {
  server.close();
  server.closeAllConnections();
  fs.rmSync(temp, { recursive: true, force: true });
}
