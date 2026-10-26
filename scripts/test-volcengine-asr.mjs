import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';

assert.ok(fs.existsSync(new URL('../src/volcengine-asr.js', import.meta.url)), 'the Doubao ASR adapter must exist');
const { VolcengineAsr } = await import('../src/volcengine-asr.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'volcengine-asr-test-'));
const apiKeyFile = path.join(temp, 'api-key.txt');
const apiKey = 'fixture-asr-key-never-log';
const sessions = [];
const sockets = new Set();
let mode = 'success';

function wsFrame(payload, opcode = 2) {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(data.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = data.length < 126 ? data.length : 126;
  if (data.length >= 126) header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

function response(payload, { flags = 1, sequence = 1, compressed = true, errorCode, event } = {}) {
  const data = Buffer.from(JSON.stringify(payload));
  const body = compressed ? gzipSync(data) : data;
  const parts = [Buffer.from([0x11, ((errorCode === undefined ? 9 : 15) << 4) | flags, 0x10 | Number(compressed), 0])];
  const integer = (value, signed = false) => {
    const b = Buffer.alloc(4);
    if (signed) b.writeInt32BE(value); else b.writeUInt32BE(value);
    return b;
  };
  if (flags & 1) parts.push(integer(sequence, true));
  if (flags & 4) parts.push(integer(event ?? 100, true));
  if (errorCode !== undefined) parts.push(integer(errorCode));
  parts.push(integer(body.length), body);
  return Buffer.concat(parts);
}

function onClientMessage(socket, session, payload) {
  const frame = {
    header: [...payload.subarray(0, 4)], sequence: payload.readInt32BE(4),
    size: payload.readUInt32BE(8), body: gunzipSync(payload.subarray(12)), time: Date.now()
  };
  assert.equal(frame.size, payload.length - 12, 'payload size describes compressed data');
  session.frames.push(frame);
  if ((frame.header[1] >> 4) === 1) {
    if (session.mode === 'timeout') return;
    if (session.mode === 'service-error') {
      socket.write(wsFrame(response({ message: apiKey }, { flags: 0, errorCode: 45000081 })));
      return;
    }
    if (session.mode === 'malformed') {
      socket.write(wsFrame(Buffer.from([0x11, 0x91, 0x11, 0])));
      return;
    }
    if (session.mode === 'invalid-gzip') {
      const invalid = response({ result: { text: 'invalid' } });
      invalid.fill(0, 12);
      socket.write(wsFrame(invalid));
      return;
    }
    if (session.mode === 'wrong-version') {
      const invalid = response({ result: {} });
      invalid[0] = 0x21;
      socket.write(wsFrame(invalid));
      return;
    }
    if (session.mode === 'wrong-length') {
      const invalid = response({ result: {} });
      invalid.writeUInt32BE(invalid.length, 8);
      socket.write(wsFrame(invalid));
      return;
    }
    if (session.mode === 'early-final') {
      socket.write(wsFrame(response({ result: { text: '不完整音频' } }, { flags: 3, sequence: -1 })));
      return;
    }
    if (session.mode === 'invalid-json') {
      const body = Buffer.from('{"result":');
      const invalid = Buffer.alloc(12 + body.length);
      invalid.set([0x11, 0x91, 0x10, 0]);
      invalid.writeInt32BE(1, 4); invalid.writeUInt32BE(body.length, 8); body.copy(invalid, 12);
      socket.write(wsFrame(invalid));
      return;
    }
    if (session.mode === 'text-frame') { socket.write(wsFrame(apiKey, 1)); return; }
    setTimeout(() => {
      if (socket.destroyed) return;
      session.ackTime = Date.now();
      socket.write(wsFrame(response({ audio_info: {}, result: {} }, { compressed: false })));
    }, 25);
    return;
  }
  assert.ok(session.ackTime <= frame.time, 'audio follows the initial response');
  if (frame.sequence > 0) {
    // A definite utterance is still an intermediate response for the whole request.
    socket.write(wsFrame(response({ result: { text: '中间结果', utterances: [{ definite: true, text: '中间结果' }] } })));
    return;
  }
  if (session.mode === 'premature-close') { socket.end(wsFrame(Buffer.alloc(0), 8)); return; }
  if (session.mode === 'abrupt-close') { socket.destroy(); return; }
  if (session.mode === 'wait-final') return;
  if (session.mode === 'invalid-result') {
    socket.write(wsFrame(response({ result: apiKey }, { flags: 3, sequence: -7 })));
    return;
  }
  if (session.mode === 'late-service-error') {
    socket.write(wsFrame(response({ message: apiKey }, { flags: 0, errorCode: 45000000 })));
    return;
  }
  if (session.mode === 'invalid-text') {
    socket.write(wsFrame(response({ result: { text: [apiKey] } }, { flags: 3, sequence: -7 })));
    return;
  }
  const text = session.mode === 'empty' ? '  ' : ' 最终结果已修正。 ';
  // Full results replace previous text; the final flag is authoritative even with a positive sequence.
  const flags = session.mode === 'event-final' ? 7 : session.mode === 'no-sequence-final' ? 2 : 3;
  socket.write(wsFrame(response({ result: { text } }, { flags, sequence: session.mode === 'positive-final' ? 7 : -7 })));
}

const server = http.createServer();
server.on('upgrade', (req, socket, head) => {
  const session = { headers: req.headers, url: req.url, mode, frames: [] };
  sessions.push(session); sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  if (mode === 'handshake-error') {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${apiKey.length}\r\n\r\n${apiKey}`);
    return;
  }
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = head;
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 15;
      const masked = Boolean(pending[1] & 128);
      let size = pending[1] & 127;
      let offset = 2;
      if (size === 126) {
        if (pending.length < 4) return;
        size = pending.readUInt16BE(2); offset = 4;
      } else if (size === 127) {
        if (pending.length < 10) return;
        size = Number(pending.readBigUInt64BE(2)); offset = 10;
      }
      if (pending.length < offset + (masked ? 4 : 0) + size) return;
      assert.ok(masked, 'WebSocket client frames must be masked');
      const mask = pending.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(pending.subarray(offset, offset + size));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      pending = pending.subarray(offset + size);
      if (opcode === 8) { socket.end(wsFrame(payload, 8)); return; }
      assert.equal(opcode, 2, 'ASR protocol uses binary WebSocket messages');
      onClientMessage(socket, session, payload);
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  provider: 'volcengine-asr-2.0', endpoint: `ws://127.0.0.1:${server.address().port}/api/v3/sauc/bigmodel_async`,
  apiKeyFile, resourceId: 'volc.seedasr.sauc.duration',
  audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
  request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, result_type: 'full' },
  chunkDurationMs: 200, timeoutMs: 1800
};
const pcm = Buffer.alloc(6400 * 2 + 800);
for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 29) % 256;
try {
  fs.writeFileSync(apiKeyFile, `\uFEFF${apiKey}\r\n`);
  const mutableConfig = structuredClone(config);
  const asr = new VolcengineAsr(mutableConfig);
  fs.writeFileSync(apiKeyFile, 'changed-after-startup');
  mutableConfig.resourceId = 'changed-resource';
  mutableConfig.audio.rate = 8000;
  mutableConfig.request.enable_punc = false;
  assert.equal(await asr.transcribe(pcm), '最终结果已修正。');
  const session = sessions.at(-1);
  assert.equal(session.url, '/api/v3/sauc/bigmodel_async');
  assert.equal(session.headers['x-api-key'], apiKey);
  assert.equal(session.headers['x-api-resource-id'], config.resourceId);
  assert.match(session.headers['x-api-request-id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(session.frames.map(frame => frame.header), [[17, 17, 17, 0], [17, 33, 1, 0], [17, 33, 1, 0], [17, 35, 1, 0]]);
  assert.deepEqual(session.frames.map(frame => frame.sequence), [1, 2, 3, -4]);
  const init = JSON.parse(session.frames[0].body);
  assert.deepEqual(init.audio, config.audio);
  assert.deepEqual(init.request, config.request);
  assert.ok(!('language' in init.audio));
  assert.deepEqual(Buffer.concat(session.frames.slice(1).map(frame => frame.body)), pcm);
  assert.deepEqual(session.frames.slice(1).map(frame => frame.body.length), [6400, 6400, 800]);
  assert.ok(session.frames[2].time - session.frames[1].time >= 170, 'chunks must be paced');
  assert.ok(session.frames[3].time - session.frames[2].time >= 170, 'final chunk must follow the same pacing');
  assert.ok(!JSON.stringify(asr).includes(apiKey), 'the snapshotted API key is private');
  for (const successMode of ['positive-final', 'no-sequence-final', 'event-final']) {
    mode = successMode;
    assert.equal(await asr.transcribe(pcm.subarray(0, 800)), '最终结果已修正。', successMode);
    assert.deepEqual(sessions.at(-1).frames.map(frame => frame.sequence), [1, -2], 'a single audio chunk is explicitly final');
  }
  assert.equal(new Set(sessions.map(session => session.headers['x-api-request-id'])).size, sessions.length);
  for (const [failureMode, expected] of [
    ['service-error', /45000081/], ['late-service-error', /45000000/], ['handshake-error', /连接|握手|WebSocket/],
    ['malformed', /协议|格式|完整/], ['invalid-gzip', /压缩|格式|协议/], ['wrong-version', /协议|版本/],
    ['wrong-length', /协议|格式|完整/], ['early-final', /完整|结束/], ['invalid-result', /协议|格式/],
    ['invalid-json', /JSON|格式/], ['text-frame', /二进制|协议|格式/],
    ['premature-close', /结束|完整|断开/], ['abrupt-close', /结束|完整|断开/],
    ['wait-final', /超时/], ['timeout', /超时/], ['invalid-text', /文本|格式/], ['empty', /文本|为空/]
  ]) {
    mode = failureMode;
    const before = sessions.length;
    await assert.rejects(asr.transcribe(pcm), error => {
      assert.match(error.message, expected, failureMode);
      assert.ok(!error.message.includes(apiKey), 'errors must not echo credentials');
      return true;
    });
    assert.equal(sessions.length, before + 1, `${failureMode}: no retry or fallback`);
  }
  const beforeInvalidInput = sessions.length;
  await assert.rejects(asr.transcribe(Buffer.alloc(0)), /PCM|音频/);
  await assert.rejects(asr.transcribe(Buffer.from([1])), /PCM|音频/);
  assert.equal(sessions.length, beforeInvalidInput, 'invalid PCM does not open a connection');
  assert.throws(() => new VolcengineAsr({ ...config, apiKeyFile: path.join(temp, 'missing') }), /API Key|凭据/);
  fs.writeFileSync(apiKeyFile, ' \r\n');
  assert.throws(() => new VolcengineAsr(config), /API Key|凭据/);
  console.log('PASS Volcengine ASR: real WebSocket framing, key/config snapshot, paced PCM, terminal full results, safe failures without retry/fallback');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  const resolvedTemp = path.resolve(temp);
  assert.ok(resolvedTemp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolvedTemp).startsWith('volcengine-asr-test-'));
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
