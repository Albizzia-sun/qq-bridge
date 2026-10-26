import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { LocalVoice } from '../src/local-voice.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'volcengine-tts-test-'));
const apiKeyFile = path.join(temp, 'api-key.txt');
const apiKey = 'fixture-api-key-never-log';
fs.writeFileSync(apiKeyFile, `\uFEFF${apiKey}\r\n`);
const pcm = Buffer.from([0, 0, 1, 0, 255, 127, 0, 128]);
const requests = [];
let mode = 'success';
const frame = (code, data = null, extra = {}) => JSON.stringify({ code, data, ...extra });
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
  if (mode === 'http-error') { res.writeHead(403); res.end(apiKey); return; }
  if (mode === 'redirect') { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'x-tt-logid': 'fixturelog123' });
  if (mode === 'service-error') { res.end(`${frame(45000000, null, { message: apiKey })}\n`); return; }
  if (mode === 'empty') { res.end(frame(20000000)); return; }
  if (mode === 'invalid-json') { res.end('not-json'); return; }
  if (mode === 'invalid-base64') { res.end(`${frame(0, '@invalid@')}\n${frame(20000000)}\n`); return; }
  if (mode === 'odd-pcm') { res.end(`${frame(0, Buffer.from([1]).toString('base64'))}\n${frame(20000000)}\n`); return; }
  const body = `${frame(0, pcm.subarray(0, 3).toString('base64'))}\r\n${frame(0, null, { sentence: { text: '分片边界' } })}\n${frame(0, pcm.subarray(3).toString('base64'))}\n${mode === 'truncated' ? '' : frame(20000000)}`;
  const bytes = Buffer.from(body);
  // Transport chunks need not align with JSON records, UTF-8 characters, or PCM samples.
  for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  tts: {
    provider: 'volcengine-icl-2.0',
    endpoint: `http://127.0.0.1:${server.address().port}/api/v3/tts/unidirectional`,
    apiKeyFile, resourceId: 'seed-icl-2.0', speaker: 'fixture_fixed_voice',
    model: 'seed-tts-2.0-standard',
    audioParams: { format: 'pcm', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 },
    additions: { explicit_language: 'zh-cn' }, timeoutMs: 3000
  }, outputDir: path.join(temp, 'audio')
};
try {
  const voice = new LocalVoice(config);
  fs.writeFileSync(apiKeyFile, 'different-key-after-startup');
  config.tts.speaker = 'different-voice-after-startup';
  config.tts.audioParams.speech_rate = 50;
  const output = await voice.synthesize('原样朗读：你好（今天）。');
  const wav = fs.readFileSync(output);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.equal(requests[0].url, '/api/v3/tts/unidirectional');
  assert.equal(requests[0].headers['x-api-key'], apiKey);
  assert.equal(requests[0].headers['x-api-resource-id'], 'seed-icl-2.0');
  assert.match(requests[0].headers['x-api-request-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(requests[0].body, { req_params: {
    text: '原样朗读：你好（今天）。', speaker: 'fixture_fixed_voice', model: 'seed-tts-2.0-standard',
    audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 },
    additions: JSON.stringify({ explicit_language: 'zh-cn' })
  } });
  assert.ok(!JSON.stringify(voice).includes(apiKey), 'the loaded key must not be exposed in enumerable configuration');
  for (const [failureMode, expected] of [
    ['http-error', /403/], ['redirect', /fetch|redirect/i], ['service-error', /45000000/], ['truncated', /结束|完整/],
    ['empty', /音频/], ['invalid-json', /JSON|格式/], ['invalid-base64', /音频|base64/], ['odd-pcm', /PCM|音频/]
  ]) {
    mode = failureMode;
    const countBefore = requests.length;
    const filesBefore = fs.readdirSync(config.outputDir);
    await assert.rejects(voice.synthesize('失败不得改用其他服务。'), error => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(apiKey));
      return true;
    }, failureMode);
    assert.equal(requests.length, countBefore + 1, 'a failed request must not retry or fall back');
    assert.deepEqual(fs.readdirSync(config.outputDir), filesBefore, 'failed or incomplete audio must not be saved');
  }
  assert.throws(() => new LocalVoice({ ...config, tts: { ...config.tts, apiKeyFile: path.join(temp, 'missing-key') } }), /API Key|凭据/);
  console.log('PASS Volcengine TTS: fixed credentials/profile, chunked PCM to WAV, completion/error validation, no retry/fallback');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
