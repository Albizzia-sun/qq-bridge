import fs from 'node:fs';
import crypto from 'node:crypto';

// HTTP Chunked V3 returns JSON records containing base64 PCM, followed by
// code 20000000. A closed HTTP response alone does not mean synthesis finished.
// https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh
export class VolcengineTts {
  #apiKey;
  #config;

  constructor(config) {
    this.#config = structuredClone(config);
    try { this.#apiKey = fs.readFileSync(config.apiKeyFile, 'utf8').replace(/^\uFEFF/, '').trim(); }
    catch { throw new Error('火山 TTS 配置失败：无法读取 API Key 凭据文件'); }
    if (!this.#apiKey) throw new Error('火山 TTS 配置失败：API Key 凭据为空');
    if (config.audioParams?.format !== 'pcm' || !Number.isInteger(config.audioParams?.sample_rate) || config.audioParams.sample_rate <= 0) {
      throw new Error('火山 TTS 配置失败：需要 PCM 格式和有效采样率');
    }
  }

  async synthesize(text, contextText) {
    const tts = this.#config;
    const reqParams = { text: String(text), speaker: tts.speaker, model: tts.model, audio_params: tts.audioParams };
    if (contextText !== undefined && (typeof contextText !== 'string' || !contextText.trim())) {
      throw new Error('火山 TTS 合成失败：语气指令必须是非空字符串');
    }
    // 每次请求单独组装 additions：并发会话之间不会共用同一个场景语气。
    // 其他合成参数（音色、模型、音频参数）由配置固定，模型无法通过工具参数改动。
    const additions = contextText === undefined ? tts.additions : { ...tts.additions, context_texts: [contextText] };
    if (additions !== undefined) reqParams.additions = JSON.stringify(additions);
    const response = await fetch(tts.endpoint, {
      method: 'POST',
      redirect: 'error', // Keep the API credential on the configured service endpoint.
      headers: {
        'content-type': 'application/json', 'X-Api-Key': this.#apiKey,
        'X-Api-Resource-Id': tts.resourceId, 'X-Api-Request-Id': crypto.randomUUID()
      },
      body: JSON.stringify({ req_params: reqParams }), signal: AbortSignal.timeout(tts.timeoutMs || 300000)
    });
    // Do not include raw response bodies: authentication failures can echo credentials.
    if (!response.ok) throw new Error(`火山 TTS 合成失败：HTTP ${response.status}`);
    const chunks = [];
    let finished = false;
    for (const line of (await response.text()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (finished) throw new Error('火山 TTS 合成失败：结束标记后仍有响应数据');
      let frame;
      try { frame = JSON.parse(line); }
      catch { throw new Error('火山 TTS 合成失败：响应 JSON 格式无效'); }
      if (!frame || !Number.isInteger(frame.code)) throw new Error('火山 TTS 合成失败：响应状态格式无效');
      if (frame.code !== 0 && frame.code !== 20000000) {
        const logId = response.headers.get('x-tt-logid');
        const trace = logId && /^[A-Za-z0-9_-]+$/.test(logId) ? `，Log ID ${logId}` : '';
        throw new Error(`火山 TTS 合成失败：服务错误码 ${frame.code}${trace}`);
      }
      if (frame.data != null && frame.data !== '') {
        if (typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) {
          throw new Error('火山 TTS 合成失败：音频 base64 格式无效');
        }
        const bytes = Buffer.from(frame.data, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== frame.data.replace(/=+$/, '')) {
          throw new Error('火山 TTS 合成失败：音频 base64 数据无效');
        }
        chunks.push(bytes);
      }
      finished = frame.code === 20000000;
    }
    if (!finished) throw new Error('火山 TTS 合成失败：未收到完整合成的结束标记');
    const pcm = Buffer.concat(chunks);
    if (!pcm.length || pcm.length % 2 !== 0) throw new Error('火山 TTS 合成失败：PCM 音频为空或不完整');
    // The selected PCM output is signed 16-bit little-endian mono. Wrap it once
    // after completion, since requesting streaming WAV can repeat WAV headers.
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(tts.audioParams.sample_rate, 24);
    wav.writeUInt32LE(tts.audioParams.sample_rate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    return wav;
  }
}
