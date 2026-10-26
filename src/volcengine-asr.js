import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Doubao streaming ASR v3 uses a binary protocol inside each WebSocket message.
// https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh
function clientFrame(type, sequence, payload) {
  const compressed = gzipSync(payload);
  const header = Buffer.from([0x11, (type << 4) | (sequence < 0 ? 3 : 1), (type === 1 ? 0x10 : 0) | 1, 0]);
  const metadata = Buffer.alloc(8);
  metadata.writeInt32BE(sequence, 0);
  metadata.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([header, metadata, compressed]);
}

function serverFrame(data) {
  const invalid = () => new Error('火山 ASR 识别失败：响应协议格式无效或数据不完整');
  if (!(data instanceof ArrayBuffer)) throw invalid();
  const bytes = Buffer.from(data);
  if (bytes.length < 4 || bytes[0] >> 4 !== 1) throw invalid();
  const type = bytes[1] >> 4;
  const flags = bytes[1] & 15;
  const serialization = bytes[2] >> 4;
  const compression = bytes[2] & 15;
  let offset = (bytes[0] & 15) * 4;
  if (offset < 4 || offset > bytes.length || ![9, 15].includes(type) || flags > 7 || compression > 1) throw invalid();
  const readInteger = () => {
    if (offset + 4 > bytes.length) throw invalid();
    const value = bytes.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  if (flags & 1) readInteger(); // The terminal flag, not the sign alone, marks completion.
  if (flags & 4) readInteger(); // Optional event field precedes payload metadata.
  const errorCode = type === 15 ? readInteger() : undefined;
  const size = readInteger();
  if (offset + size !== bytes.length) throw invalid();
  let body = bytes.subarray(offset);
  if (compression === 1) {
    try { body = gunzipSync(body); }
    catch { throw new Error('火山 ASR 识别失败：响应压缩格式无效'); }
  }
  // Service messages may echo request headers, so surface only the numeric code.
  if (type === 15) throw new Error(`火山 ASR 识别失败：服务错误码 ${errorCode}`);
  if (serialization !== 1) throw invalid();
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('火山 ASR 识别失败：响应 JSON 格式无效'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  if (payload.result !== undefined && (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result))) throw invalid();
  const text = payload.result?.text;
  if (text !== undefined && typeof text !== 'string') throw new Error('火山 ASR 识别失败：识别文本格式无效');
  return { text, final: Boolean(flags & 2) };
}

export class VolcengineAsr {
  #apiKey;
  #config;

  constructor(config) {
    this.#config = structuredClone(config);
    try { this.#apiKey = fs.readFileSync(config.apiKeyFile, 'utf8').replace(/^\uFEFF/, '').trim(); }
    catch { throw new Error('火山 ASR 配置失败：无法读取 API Key 凭据文件'); }
    if (!this.#apiKey) throw new Error('火山 ASR 配置失败：API Key 凭据为空');
    const audio = config.audio;
    if (audio?.format !== 'pcm' || audio.codec !== 'raw' || audio.rate !== 16000 || audio.bits !== 16 || audio.channel !== 1) {
      throw new Error('火山 ASR 配置失败：需要 16 kHz、16 位、单声道原始 PCM 音频');
    }
    if (!Number.isInteger(config.chunkDurationMs) || config.chunkDurationMs <= 0 || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error('火山 ASR 配置失败：音频分块时长和超时必须是正整数');
    }
  }

  async transcribe(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer) || !pcmBuffer.length || pcmBuffer.length % 2 !== 0) {
      throw new Error('火山 ASR 识别失败：PCM 音频为空或不完整');
    }
    const config = this.#config;
    const chunkBytes = config.audio.rate * 2 * config.chunkDurationMs / 1000;
    return new Promise((resolve, reject) => {
      let socket;
      let sendTimer;
      let finished = false;
      let sending = false;
      let sentFinal = false;
      let text = '';
      let offset = 0;
      let sequence = 2;
      const timeout = setTimeout(() => finish(new Error('火山 ASR 识别失败：等待完整识别结果超时')), config.timeoutMs);
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(sendTimer);
        try { socket?.close(); } catch { /* Settlement must not be replaced by a close error. */ }
        if (error) reject(error); else resolve(result);
      };
      const sendAudio = () => {
        if (finished) return;
        const end = Math.min(offset + chunkBytes, pcmBuffer.length);
        const final = end === pcmBuffer.length;
        try { socket.send(clientFrame(2, final ? -sequence : sequence, pcmBuffer.subarray(offset, end))); }
        catch { finish(new Error('火山 ASR 识别失败：发送音频时 WebSocket 连接异常')); return; }
        offset = end;
        sequence += 1;
        sentFinal = final;
        if (!final) sendTimer = setTimeout(sendAudio, config.chunkDurationMs);
      };
      try {
        socket = new WebSocket(config.endpoint, { headers: {
          'X-Api-Key': this.#apiKey, 'X-Api-Resource-Id': config.resourceId, 'X-Api-Request-Id': randomUUID()
        } });
        socket.binaryType = 'arraybuffer';
      } catch {
        finish(new Error('火山 ASR 识别失败：无法建立 WebSocket 连接'));
        return;
      }
      socket.addEventListener('open', () => {
        if (finished) return;
        const payload = { audio: config.audio, request: config.request };
        try { socket.send(clientFrame(1, 1, Buffer.from(JSON.stringify(payload)))); }
        catch { finish(new Error('火山 ASR 识别失败：发送配置时 WebSocket 连接异常')); }
      });
      socket.addEventListener('message', event => {
        if (finished) return;
        let frame;
        try { frame = serverFrame(event.data); }
        catch (error) { finish(error); return; }
        // result_type=full contains the latest whole transcript, including corrections.
        if (frame.text !== undefined) text = frame.text;
        if (frame.final) {
          if (!sentFinal) { finish(new Error('火山 ASR 识别失败：音频发送完整前收到结束标记')); return; }
          if (!text.trim()) { finish(new Error('火山 ASR 识别失败：最终识别文本为空')); return; }
          finish(null, text.trim());
        } else if (!sending) {
          // Follow the official demo: acknowledge the initial request once, then
          // send and receive concurrently. Async ASR does not reply to every chunk.
          sending = true;
          sendAudio();
        }
      });
      socket.addEventListener('error', () => finish(new Error('火山 ASR 识别失败：WebSocket 连接或握手失败，识别未完整结束')));
      socket.addEventListener('close', () => finish(new Error('火山 ASR 识别失败：连接在完整识别结束前断开')));
    });
  }
}
