import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VolcengineTts } from './volcengine-tts.js';
import { VolcengineAsr } from './volcengine-asr.js';
import { loadVoiceStyles, resolveVoiceStyle, voiceStyleGuidance } from './voice-styles.js';

const runFile = promisify(execFile);

// Parameters are read once at bridge startup. The model cannot replace the
// reference voice or tune inference settings through a chat/tool argument.
export class LocalVoice {
  #voiceStyles = null;

  constructor(config, dependencies = {}) {
    this.config = structuredClone(config);
    for (const field of ['textVoiceProbability', 'voiceVoiceProbability']) {
      const probability = this.config.replyPolicy?.[field];
      if (probability !== undefined && (!Number.isFinite(probability) || probability < 0 || probability > 1)) {
        throw new Error(`replyPolicy.${field} 必须是 0 到 1 之间的数字`);
      }
    }
    // 场景语气（可选）：配置了 styleConfigPath 才启用，未配置时行为与以前完全一致。
    if (this.config.styleConfigPath !== undefined) {
      if (this.config.tts?.provider !== 'volcengine-icl-2.0' || this.config.tts.model !== 'seed-tts-2.0-expressive') {
        throw new Error('语气配置错误：仅支持 volcengine-icl-2.0 的 seed-tts-2.0-expressive 模型');
      }
      this.#voiceStyles = loadVoiceStyles(this.config.styleConfigPath, dependencies.configDir);
    }
    this.runFile = dependencies.runFile || runFile;
    this.cloudTts = this.config.tts?.provider === 'volcengine-icl-2.0' ? new VolcengineTts(this.config.tts) : null;
    this.cloudAsr = this.config.asr?.provider === 'volcengine-asr-2.0' ? new VolcengineAsr(this.config.asr) : null;
  }

  /** 给模型看的场景清单（只含 label / whenToUse，不含合成指令本身）。 */
  getVoiceStyleGuidance() {
    return voiceStyleGuidance(this.#voiceStyles);
  }

  /** 校验模型传来的 voiceStyle；未启用语气配置时传了就报错。 */
  validateVoiceStyle(id) {
    return resolveVoiceStyle(this.#voiceStyles, id);
  }

  async transcribeSegments(segments, gateway) {
    if (!Array.isArray(segments) || !segments.some(s => s?.type === 'record')) return { segments, isVoice: false };
    const converted = [];
    for (const segment of segments) {
      if (segment?.type !== 'record') { converted.push(segment); continue; }
      const text = await this.transcribeRecord(segment.data ?? {}, gateway);
      converted.push({ type: 'text', data: { text: `[语音转写] ${text}` } });
    }
    return { segments: converted, isVoice: true };
  }

  async transcribeRecord(record, gateway) {
    const reference = String(record.file || record.file_id || record.url || '').trim();
    if (!reference) throw new Error('本地 ASR 失败：QQ 语音没有文件引用');
    const getRecord = async (payload) => {
      const response = await fetch(`${String(gateway.httpUrl).replace(/\/+$/, '')}/get_record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(gateway.accessToken ? { authorization: `Bearer ${gateway.accessToken}` } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(60000)
      });
      const body = await response.json();
      if (!response.ok || body.status !== 'ok' || body.retcode !== 0) {
        throw new Error(`本地 ASR 获取语音失败：get_record ${body.wording || body.message || response.status}`);
      }
      return body.data ?? {};
    };
    // SnowLuma 2.1.1 performs URL refresh and SILK conversion in one call;
    // no second media lookup is required.
    const decoded = await getRecord({ file: reference, out_format: 'wav' });
    const bytes = decoded.base64 ? Buffer.from(String(decoded.base64), 'base64') : null;
    if (!bytes?.length) throw new Error('本地 ASR 获取语音失败：网关没有返回音频内容');
    const asr = this.config.asr;
    fs.mkdirSync(this.config.workDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(this.config.workDir, 'asr-'));
    try {
      const input = path.join(work, 'input.wav');
      const audio = path.join(work, this.cloudAsr ? 'audio.pcm' : 'audio.wav');
      const output = path.join(work, 'transcript');
      fs.writeFileSync(input, bytes);
      const options = { windowsHide: true, shell: false, timeout: asr.timeoutMs || 180000, maxBuffer: 4 * 1024 * 1024 };
      await this.runFile(asr.ffmpeg, ['-nostdin', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', ...(this.cloudAsr ? ['-f', 's16le'] : []), audio], options);
      if (this.cloudAsr) return await this.cloudAsr.transcribe(fs.readFileSync(audio));
      const args = ['-m', asr.model, '-f', audio, '-l', asr.language || 'zh', '-t', String(asr.threads || 8), '-ng', '-nt', '-np', '-otxt', '-of', output];
      if (asr.prompt) args.push('--prompt', asr.prompt);
      await this.runFile(asr.executable, args, options);
      const transcript = fs.readFileSync(`${output}.txt`, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!transcript) throw new Error('本地 ASR 失败：没有识别出语音内容');
      return transcript;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async synthesize(text, voiceStyle) {
    const styleId = this.validateVoiceStyle(voiceStyle);
    // 只有启用了语气配置时 styleId 才有值；此时用它替换本轮的固定语气指令。
    const contextText = styleId === undefined ? undefined : this.#voiceStyles.styles[styleId].instruction;
    const tts = this.config.tts;
    let bytes;
    if (this.cloudTts) {
      bytes = await this.cloudTts.synthesize(text, contextText);
    } else {
      // IndexTTS owns the accepted reference and inference settings in its fixed
      // startup profile. A message supplies only the text to speak.
      const payload = tts.provider === 'indextts-2.5' ? { text: String(text) } : {
        ...tts.parameters,
        text: String(text), text_lang: tts.parameters?.text_lang || 'zh',
        ref_audio_path: tts.referenceAudio, prompt_text: tts.referenceText,
        prompt_lang: tts.parameters?.prompt_lang || 'zh', media_type: 'wav', streaming_mode: false
      };
      const response = await fetch(`${String(tts.baseUrl).replace(/\/+$/, '')}/tts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(tts.timeoutMs || 300000)
      });
      if (!response.ok) throw new Error(`本地 TTS 合成失败：HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('本地 TTS 合成失败：服务没有返回有效 WAV 音频');
    }
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const output = path.join(this.config.outputDir, `reply-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(output, bytes, { flag: 'wx' });
    return output;
  }
}

// Track only unread input actually shown to the model. Merely receiving a new
// message or browsing old history must not change an in-flight reply's format.
export function noteVoiceReplySource(state, messages) {
  const unread = new Set((state.unread || []).map(m => m.seq));
  for (const message of messages) {
    if (message?.isSelf || !Number.isSafeInteger(message?.seq) || !unread.has(message.seq)) continue;
    const receivedOrder = message.receivedOrder ?? message.seq;
    if (state.localVoiceReplySource && receivedOrder <= (state.localVoiceReplySource.receivedOrder ?? state.localVoiceReplySource.seq)) continue;
    state.localVoiceReplySource = { seq: message.seq, receivedOrder, messageId: message.messageId, isVoice: message.isVoice === true };
  }
}

export function shouldReplyWithVoice(state, replyToMessageId, resolvedReplyInfo = null, replyPolicy = {}, random = Math.random) {
  let source;
  if (replyToMessageId != null && String(replyToMessageId).trim()) {
    source = resolvedReplyInfo || (state.recentMessages || []).find(m => !m.isSelf && String(m.messageId) === String(replyToMessageId));
  } else source = state.localVoiceReplySource;
  if (!source || source.isSelf === true) return false;
  const probability = source.isVoice === true
    ? (replyPolicy?.voiceVoiceProbability ?? 1)
    : (replyPolicy?.textVoiceProbability ?? 0);
  if (probability === 0) return false;
  if (probability === 1) return true;
  return random() < probability;
}
