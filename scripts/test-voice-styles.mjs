import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { LocalVoice } from '../src/local-voice.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-styles-test-'));
const configDir = path.join(temp, 'configuration');
fs.mkdirSync(configDir);
const stylePath = path.join(configDir, 'voice-styles.json');
const apiKeyFile = path.join(temp, 'api-key.txt');
fs.writeFileSync(apiKeyFile, 'fixture-key');
const styles = {
  version: 1,
  defaultStyle: 'daily',
  styles: {
    daily: { label: '测试日常', whenToUse: '日常闲聊或场景不明确', instruction: '日常语气测试指令' },
    comfort: { label: '测试安慰', whenToUse: '安慰或倾听', instruction: '安慰语气测试指令' },
    explanation: { label: '测试解释', whenToUse: '解释或澄清', instruction: '解释语气测试指令' }
  }
};
const saveStyles = (value = styles) => fs.writeFileSync(stylePath, JSON.stringify(value));
saveStyles();
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  // Different completion order ensures a shared additions object cannot leak styles.
  await new Promise(resolve => setTimeout(resolve, body.req_params.text === '日常并发' ? 20 : 1));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify({ code: 0, data: Buffer.from([0, 0, 1, 0]).toString('base64') })}\n${JSON.stringify({ code: 20000000 })}`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  styleConfigPath: 'voice-styles.json',
  tts: {
    provider: 'volcengine-icl-2.0', endpoint: `http://127.0.0.1:${server.address().port}/tts`,
    apiKeyFile, resourceId: 'seed-icl-2.0', speaker: 'fixture_fixed_voice', model: 'seed-tts-2.0-expressive',
    audioParams: { format: 'pcm', sample_rate: 24000, speech_rate: 0, loudness_rate: 0 },
    additions: { max_length_to_filter_parenthesis: 0, context_texts: ['原有固定语气'], nested: { preserved: true } },
    timeoutMs: 3000
  },
  outputDir: path.join(temp, 'audio'), replyPolicy: { textVoiceProbability: 0.2, voiceVoiceProbability: 1 }
};

try {
  const baseline = structuredClone(config);
  const voice = new LocalVoice(config, { configDir });
  const guidance = voice.getVoiceStyleGuidance();
  assert.equal(guidance.defaultStyle, 'daily');
  assert.match(guidance.instruction, /voiceStyle/);
  assert.deepEqual(guidance.styles, Object.fromEntries(Object.entries(styles.styles).map(([id, style]) => [id, {
    label: style.label, whenToUse: style.whenToUse
  }])));
  assert.ok(!JSON.stringify(guidance).includes('测试指令'), 'model guidance must not expose synthesis instructions');
  assert.ok(!JSON.stringify(guidance).includes('fixture-key'), 'model guidance must not expose credentials');
  guidance.styles.comfort.label = '外部修改';
  assert.equal(voice.getVoiceStyleGuidance().styles.comfort.label, styles.styles.comfort.label);
  assert.doesNotThrow(() => voice.validateVoiceStyle(undefined));
  for (const id of Object.keys(styles.styles)) assert.doesNotThrow(() => voice.validateVoiceStyle(id));
  for (const id of [null, '', 'unknown', '__proto__', 'toString', {}, ['daily']]) {
    assert.throws(() => voice.validateVoiceStyle(id), /voiceStyle/);
    const countBefore = requests.length;
    await assert.rejects(voice.synthesize('不能发送', id), /voiceStyle/);
    assert.equal(requests.length, countBefore, 'an invalid style must fail before synthesis');
  }

  // Both JSON edits and caller object changes take effect only on next startup.
  saveStyles({ ...styles, styles: { ...styles.styles, comfort: { ...styles.styles.comfort, instruction: '之后才生效' } } });
  config.tts.additions.context_texts[0] = '调用方修改';
  config.tts.speaker = '调用方修改';
  await voice.synthesize('默认语气');
  await Promise.all([
    voice.synthesize('日常并发', 'daily'),
    voice.synthesize('安慰并发', 'comfort'),
    voice.synthesize('解释并发', 'explanation')
  ]);
  const expectedStyles = { 默认语气: 'daily', 日常并发: 'daily', 安慰并发: 'comfort', 解释并发: 'explanation' };
  assert.equal(requests.length, 4);
  for (const { req_params: request } of requests) {
    assert.deepEqual(request, {
      text: request.text,
      speaker: baseline.tts.speaker,
      model: baseline.tts.model,
      audio_params: baseline.tts.audioParams,
      additions: JSON.stringify({ ...baseline.tts.additions, context_texts: [styles.styles[expectedStyles[request.text]].instruction] })
    }, 'only context_texts may vary with the selected scene');
  }
  assert.deepEqual(voice.config, baseline, 'synthesis must not mutate shared configuration');
  assert.equal(fs.readdirSync(baseline.outputDir).length, 4);

  saveStyles();
  const absoluteVoice = new LocalVoice({ ...baseline, styleConfigPath: stylePath });
  assert.equal(absoluteVoice.getVoiceStyleGuidance().defaultStyle, 'daily');
  saveStyles({ ...styles, defaultStyle: 'comfort' });
  const alternateDefault = new LocalVoice(baseline, { configDir });
  await alternateDefault.synthesize('修改默认场景');
  assert.deepEqual(JSON.parse(requests.at(-1).req_params.additions).context_texts, [styles.styles.comfort.instruction]);

  const withoutStyles = structuredClone(baseline);
  delete withoutStyles.styleConfigPath;
  const legacyVoice = new LocalVoice(withoutStyles);
  assert.equal(legacyVoice.getVoiceStyleGuidance(), null);
  assert.doesNotThrow(() => legacyVoice.validateVoiceStyle(undefined));
  assert.throws(() => legacyVoice.validateVoiceStyle('daily'), /voiceStyle|语气配置/);
  await legacyVoice.synthesize('原有固定语气');
  assert.deepEqual(JSON.parse(requests.at(-1).req_params.additions), baseline.tts.additions);

  const invalidProfiles = [
    null, [], {}, { ...styles, version: 2 }, { ...styles, defaultStyle: 'missing' },
    { ...styles, styles: { ...styles.styles, extra: styles.styles.daily } },
    { ...styles, styles: { daily: styles.styles.daily, comfort: styles.styles.comfort } },
    ...['label', 'whenToUse', 'instruction'].flatMap(field => [null, '', '   ', 1].map(value => ({
      ...styles, styles: { ...styles.styles, daily: { ...styles.styles.daily, [field]: value } }
    })))
  ];
  for (const invalid of invalidProfiles) {
    saveStyles(invalid);
    assert.throws(() => new LocalVoice(baseline, { configDir }), /语气配置/);
  }
  fs.writeFileSync(stylePath, '{"version":');
  assert.throws(() => new LocalVoice(baseline, { configDir }), /语气配置/);
  assert.throws(() => new LocalVoice({ ...baseline, styleConfigPath: 'missing.json' }, { configDir }), /语气配置/);
  for (const badPath of [null, '', '  ', 1]) {
    assert.throws(() => new LocalVoice({ ...baseline, styleConfigPath: badPath }, { configDir }), /styleConfigPath|语气配置/);
  }
  saveStyles();
  for (const tts of [
    { ...baseline.tts, model: 'seed-tts-2.0-standard' },
    { provider: 'indextts-2.5', baseUrl: 'http://127.0.0.1:1' }
  ]) {
    assert.throws(() => new LocalVoice({ ...baseline, tts }, { configDir }), /expressive|语气配置/);
  }
  console.log('PASS voice styles: validated portable profile, guidance, defaults, startup snapshot, concurrency isolation, unchanged fixed parameters and legacy behavior');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
