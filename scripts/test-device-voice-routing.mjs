import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceVoiceRouting, isDeviceRoutedPath } from '../src/device-voice-routing.js';

function fixture() {
  const route = createDeviceVoiceRouting();
  let seq = 0;
  const emit = (type, data) => route.observe('s1', { type, seq: seq++, data });
  const r = route.register('private:123', 's1');
  const start = () => { emit('turn/start', { turn: 2 }); emit('user/message', { source: { kind: 'user', rpcId: r.requestId } }); };
  const call = (id, text, voiceStyle = 'daily') => emit('tool/call', { name: 'mcp__snowluma__qq_send_message', callId: id, arguments: JSON.stringify({ key: r.key, token: 'old-qq-token', messages: text, voiceStyle }) });
  const result = (id, isError = false) => emit('tool/result', { message: { source: { callId: id }, isError, content: [{ type: 'text', text: '{}' }] } });
  const capture = (messages, voiceStyle) => route.capture(route.claim('s1', '/api/socialV2/send-message', { key: r.key, messages, voiceStyle }, 'old-qq-token'), r.key, messages, voiceStyle);
  return { route, emit, r, start, call, result, capture };
}

test('设备排队不抢占QQ turn，实际rpcId才绑定来源，正式结果等turn/end', async () => {
  const f = fixture();
  f.emit('turn/start', { turn: 1 });
  f.emit('user/message', { source: { kind: 'user', rpcId: 'qq-request' } });
  assert.equal(f.route.isDevice('s1'), false);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.start();
  assert.equal(f.route.isDevice('s1'), true);
  f.call('c1', ['你好'], 'comfort');
  f.capture(['你好'], 'comfort');
  f.result('c1');
  let completed = false;
  f.r.promise.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  const end = f.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal(end.device, true);
  assert.deepEqual(await f.r.promise, { segments: [{ text: '你好', voiceStyle: 'comfort' }] });
  assert.equal(f.route.isDevice('s1'), false);
});

test('投影序号屏障等待user/message到达，HTTP不能绕过来源判断', async () => {
  const f = fixture();
  f.emit('turn/start', { turn: 2 });
  let passed = false;
  const barrier = f.route.synchronize('s1', async () => ({ asOfSeq: 1 })).then(() => { passed = true; });
  await Promise.resolve();
  assert.equal(passed, false);
  f.emit('user/message', { message: { source: { kind: 'user', rpcId: f.r.requestId } } });
  await barrier;
  assert.equal(f.route.isDevice('s1'), true);
});

test('取消后来源保留至turn/end，迟到回复和重启后遗留回合不会落到QQ', async () => {
  const f = fixture();
  f.start();
  f.call('late', ['迟到']);
  f.route.cancel(f.r.requestId);
  await assert.rejects(f.r.promise, { code: 'DEVICE_REQUEST_CANCELLED' });
  assert.equal(f.route.isDevice('s1'), true);
  assert.throws(() => f.capture(['迟到'], 'daily'), { code: 'DEVICE_REQUEST_CANCELLED' });
  const fresh = createDeviceVoiceRouting();
  fresh.snapshot('s1', { records: [
    { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 2 } } },
    { type: 'event', event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: f.r.requestId } } } }
  ], projections: { asOfSeq: 2 } });
  assert.equal(fresh.isDevice('s1'), true);
  assert.throws(() => fresh.capture({ device: true, source: f.r.requestId }, f.r.key, ['旧输出']), { code: 'DEVICE_REQUEST_CANCELLED' });
});

test('并行工具结果按callId配对，失败调用不被另一成功调用冒认', async () => {
  const f = fixture(); f.start();
  f.call('bad', ['失败'], 'daily'); f.call('good', ['成功'], 'explanation');
  f.capture(['失败'], 'daily');
  f.capture(['成功'], 'explanation');
  f.result('good'); f.result('bad', true);
  f.emit('turn/end', { reason: { kind: 'completed' } });
  assert.deepEqual(await f.r.promise, { segments: [{ text: '成功', voiceStyle: 'explanation' }] });
});

test('设备结束后旧token的迟到HTTP仍绑定旧设备call，不落到下一QQ turn', async () => {
  const f = fixture(); f.start(); f.call('late', ['迟到']);
  f.route.cancel(f.r.requestId);
  f.emit('turn/end', { reason: { kind: 'aborted' } });
  f.emit('turn/start', { turn: 3 });
  f.emit('user/message', { source: { kind: 'user', rpcId: 'next-qq' } });
  assert.equal(f.route.isDevice('s1'), false);
  assert.throws(() => f.capture(['迟到'], 'daily'), { code: 'DEVICE_REQUEST_CANCELLED' });
  await assert.rejects(f.r.promise);
});

test('截断snapshot不能把未知来源当QQ，高seq不能替代source证据', async () => {
  const f = fixture();
  f.route.snapshot('s1', { records: [{ type: 'assistant/message', seq: 100, data: { content: [] } }], projections: { asOfSeq: 100 } });
  await assert.rejects(f.route.synchronize('s1', async () => ({ asOfSeq: 100 })), { code: 'DEVICE_SOURCE_UNAVAILABLE' });
  f.route.observe('s1', { type: 'user/message', seq: 99, data: { source: { kind: 'user', rpcId: f.r.requestId } } });
  await assert.rejects(f.route.synchronize('s1', async () => ({ asOfSeq: 100 })), { code: 'DEVICE_SOURCE_UNAVAILABLE' });
});

test('重复设备turn/end保留设备属性，不被桥接按QQ收尾', async () => {
  const f = fixture(); f.start();
  const event = { type: 'turn/end', seq: 30, data: { reason: { kind: 'completed' } } };
  f.route.observe('s1', event);
  assert.deepEqual(f.route.observe('s1', event), { duplicate: true, device: true });
  await assert.rejects(f.r.promise);
});

test('明确未admitted的请求移除临时token；未知传输失败仍保留来源', async () => {
  const f = fixture();
  assert.equal(f.route.tokenKey(f.r.token), f.r.key);
  f.route.discard(f.r.requestId, new Error('rejected before admission'));
  await assert.rejects(f.r.promise);
  assert.equal(f.route.tokenKey(f.r.token), null);
  const next = f.route.register(f.r.key, 's1');
  f.route.cancel(next.requestId, new Error('transport outcome unknown'));
  await assert.rejects(next.promise);
  assert.equal(f.route.tokenKey(next.token), next.key);
});

test('同turn额外steer造成来源混合时拒绝猜测QQ或设备出口', async () => {
  const f = fixture(); f.start();
  f.emit('user/message', { source: { kind: 'user', rpcId: 'desktop-steer' } });
  await assert.rejects(f.route.synchronize('s1', async () => ({ asOfSeq: 2 })), { code: 'DEVICE_SOURCE_UNAVAILABLE' });
  f.emit('turn/end', { reason: { kind: 'completed' } });
  await assert.rejects(f.r.promise, { code: 'DEVICE_TURN_FAILED' });
});

test('同turn先QQ或desktop再设备也必须终结设备请求，隔离收尾和迟到工具', async () => {
  const f = fixture();
  f.emit('turn/start', { turn: 2 });
  f.emit('user/message', { source: { kind: 'user', rpcId: 'desktop-first' } });
  f.call('early-qq-call', ['混合来源回复']);
  f.emit('user/message', { source: { kind: 'user', rpcId: f.r.requestId } });
  assert.equal(f.route.isDevice('s1'), true);
  await assert.rejects(f.route.synchronize('s1', async () => ({ asOfSeq: 3 })), { code: 'DEVICE_SOURCE_UNAVAILABLE' });
  const end = f.emit('turn/end', { reason: { kind: 'completed' } });
  assert.equal(end.device, true, 'bridge must skip QQ end-of-turn side effects');
  await assert.rejects(f.r.promise, { code: 'DEVICE_TURN_FAILED' });
  assert.equal(f.route.tokenKey(f.r.token), null);
  assert.throws(() => f.capture(['混合来源回复'], 'daily'), { code: 'DEVICE_CALL_UNVERIFIED' });
  f.emit('turn/start', { turn: 3 });
  f.emit('user/message', { source: { kind: 'user', rpcId: 'qq-after' } });
  assert.equal(f.route.isDevice('s1'), false);
  await f.route.synchronize('s1', async () => ({ asOfSeq: 6 }));
});

test('同turn包含多个设备source时全部明确失败，没有遗留promise或token', async () => {
  const f = fixture();
  const second = f.route.register(f.r.key, 's1');
  f.emit('turn/start', { turn: 2 });
  f.emit('user/message', { source: { kind: 'user', rpcId: 'desktop-first' } });
  f.emit('user/message', { source: { kind: 'user', rpcId: f.r.requestId } });
  f.emit('user/message', { source: { kind: 'user', rpcId: second.requestId } });
  assert.equal(f.emit('turn/end', { reason: { kind: 'completed' } }).device, true);
  await assert.rejects(f.r.promise, { code: 'DEVICE_TURN_FAILED' });
  await assert.rejects(second.promise, { code: 'DEVICE_TURN_FAILED' });
  assert.equal(f.route.tokenKey(f.r.token), null);
  assert.equal(f.route.tokenKey(second.token), null);
});

test('无正式工具输出不使用final文本，设备操作覆盖旧发送路径和QQ等待', async () => {
  const f = fixture(); f.start();
  f.emit('assistant/message', { content: [{ type: 'text', text: '内部文本' }] });
  f.emit('turn/end', { reason: { kind: 'completed' } });
  await assert.rejects(f.r.promise, { code: 'DEVICE_REPLY_MISSING' });
  for (const path of ['/api/send/private', '/api/send/group', '/api/socialV2/send-message', '/api/socialV2/send-poke', '/api/socialV2/send-voice', '/api/socialV2/send-sticker', '/api/socialV2/wait', '/api/socialV2/wake-config']) assert.equal(isDeviceRoutedPath(path), true);
  assert.equal(isDeviceRoutedPath('/api/socialV2/memory'), false);
});
