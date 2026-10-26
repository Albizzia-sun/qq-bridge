import { randomUUID, timingSafeEqual } from 'node:crypto';

const SOURCE_PREFIX = 'esp32-voice:';
const error = (code, publicMessage) => Object.assign(new Error(publicMessage), { code, publicMessage });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const equalToken = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const parseJson = value => {
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
};
const messageText = value => {
  const messages = parseJson(value);
  return (Array.isArray(messages) ? messages : [messages]).map(item => String(item ?? '').trim()).filter(Boolean).join('\n');
};
const TOOL_PATHS = {
  qq_send_message: '/api/socialV2/send-message', qq_send_burst: '/api/socialV2/send-burst',
  qq_send_poke: '/api/socialV2/send-poke', qq_send_voice: '/api/socialV2/send-voice',
  qq_send_sticker: '/api/socialV2/send-sticker', qq_wait_for_messages: '/api/socialV2/wait',
  qq_mark_read: '/api/socialV2/mark-read', qq_set_wake_config: '/api/socialV2/wake-config',
  qq_report_feedback: '/api/socialV2/feedback', qq_record_sent: '/api/socialV2/record-sent',
  qq_send_private_message: '/api/send/private', qq_send_group_message: '/api/send/group', qq_reply: '/api/send/reply'
};
function signature(pathname, args, token) {
  const key = args?.key ?? (args?.userId ? `private:${args.userId}` : args?.groupId ? `group:${args.groupId}` : '');
  const detail = pathname.endsWith('/send-message') || pathname.endsWith('/send-burst') ? messageText(args?.messages)
    : pathname.startsWith('/api/send/') ? String(parseJson(args?.message) ?? '').trim()
    : pathname.endsWith('/send-voice') ? String(args?.voice ?? args?.file ?? '') : '';
  return JSON.stringify([pathname, key, token ?? args?.token ?? '', detail, args?.voiceStyle ?? null]);
}

// These actions belong to QQ delivery / wake bookkeeping, not a microphone turn.
export function isDeviceRoutedPath(pathname) {
  return pathname.startsWith('/api/send/') || pathname === '/api/voice/send'
    || /^\/api\/socialV2\/(send-message|send-burst|send-poke|send-voice|send-sticker|wait|mark-read|wake-config|record-sent|feedback)$/.test(pathname);
}

/** Source is native DSH metadata, never text that a model can imitate. */
export function createDeviceVoiceRouting() {
  const requests = new Map();
  const sessions = new Map();
  const enrolled = new Set();
  const waiters = new Set();
  const state = sessionId => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { seq: -1, turn: null, source: null, sourceKnown: false, connected: false, calls: new Map(), deviceEnds: new Set(), deviceSources: new Set() });
    return sessions.get(sessionId);
  };
  const isDevice = sessionId => state(sessionId).deviceSources.size > 0;
  function wake() {
    for (const waiter of waiters) {
      const s = state(waiter.sessionId);
      if (!s.connected) { waiters.delete(waiter); waiter.reject(error('DEVICE_EVENTS_UNAVAILABLE', '对话事件连接暂不可用，请稍后重试。')); }
      else if (s.seq >= waiter.seq) { waiters.delete(waiter); waiter.resolve(); }
    }
  }
  function settle(request, failure) {
    if (request.settled) return;
    request.settled = true;
    if (failure) request.reject(failure);
    else {
      const pieces = request.replies.filter(piece => piece.confirmed);
      if (!pieces.length) request.reject(error('DEVICE_REPLY_MISSING', '本轮模型没有生成正式的语音回复。'));
      else request.resolve({ segments: pieces.map(({ text, voiceStyle }) => ({ text, ...(voiceStyle ? { voiceStyle } : {}) })) });
    }
  }
  function observe(sessionId, event) {
    const s = state(sessionId);
    const data = event?.data ?? {};
    if (Number.isSafeInteger(event?.seq) && event.seq <= s.seq) return { device: s.deviceEnds.has(event.seq), duplicate: true };
    s.connected = true;
    if (event?.type === 'turn/start') { s.turn = data.turn; s.source = null; s.sourceKnown = false; s.deviceSources.clear(); }
    const source = data.source ?? data.message?.source;
    if (event?.type === 'user/message' && source?.kind === 'user' && String(source.rpcId ?? '').startsWith(SOURCE_PREFIX)) {
      // A desktop next-step message may precede the queued device input. Retain
      // every device request in this turn independently of the first source.
      s.deviceSources.add(source.rpcId);
      enrolled.add(sessionId);
    }
    if (event?.type === 'user/message' && source?.kind === 'user' && s.source === null) {
      // A queued recording is claimed at the next turn, not during a QQ turn.
      s.source = source.rpcId ?? null;
      s.sourceKnown = typeof source.rpcId === 'string';
    } else if (event?.type === 'user/message' && source?.kind === 'user' && source.rpcId !== s.source) {
      // This does not happen for the bridge's queue inputs. A separate desktop
      // steer can mix sources in one turn; it cannot authorize a guessed route.
      s.sourceKnown = false;
      for (const call of s.calls.values()) if (call.turn === s.turn && !call.consumed) call.sourceKnown = false;
    }
    const device = isDevice(sessionId);
    const request = device && s.sourceKnown ? requests.get(s.source) : null;
    if (event.type === 'tool/call') {
      const pathname = TOOL_PATHS[String(data.name ?? '').split('__').at(-1)];
      if (pathname && !s.calls.has(String(data.callId))) {
        const args = parseJson(data.arguments ?? data.input);
        s.calls.set(String(data.callId), { sessionId, turn: s.turn, callId: String(data.callId), source: s.source,
          sourceKnown: s.sourceKnown, pathname, signature: signature(pathname, args), consumed: false });
      }
    }
    if (request && event.type === 'tool/call' && /(?:^|__)qq_send_message$/.test(String(data.name))) {
      request.calls.set(String(data.callId), parseJson(data.arguments ?? data.input));
    }
    if (request && event.type === 'tool/result' && request.calls.has(String(data.message?.source?.callId))) {
      // Only a successful tool result confirms the endpoint's captured reply.
      const candidate = request.replies.find(piece => piece.callId === String(data.message?.source?.callId));
      if (candidate) {
        candidate.failed = data.message?.isError === true || data.message?.content?.some(block => block.isError === true);
        candidate.confirmed = !candidate.failed;
      }
      request.calls.delete(String(data.message?.source?.callId));
    }
    if (event.type === 'tool/result') {
      const callId = String(data.message?.source?.callId);
      const call = s.calls.get(callId);
      // A successful result proves the HTTP invocation has already returned.
      // Failed/cancelled invocations may still arrive late, so retain unclaimed calls.
      if (call && (call.consumed || data.message?.isError !== true)) s.calls.delete(callId);
    }
    if (event?.type === 'turn/end') {
      if (device && Number.isSafeInteger(event.seq)) s.deviceEnds.add(event.seq);
      for (const requestId of s.deviceSources) {
        const deviceRequest = requests.get(requestId);
        if (deviceRequest) {
          settle(deviceRequest, data.reason?.kind === 'completed' && s.sourceKnown && s.source === requestId
            ? null : error('DEVICE_TURN_FAILED', '本轮对话未正常完成或来源不明确，请重新录音。'));
          requests.delete(requestId);
        }
      }
      s.turn = null;
      s.source = null;
      s.sourceKnown = true;
      s.deviceSources.clear();
      for (const [id, call] of s.calls) if (call.consumed) s.calls.delete(id);
    }
    if (Number.isSafeInteger(event?.seq)) s.seq = event.seq;
    wake();
    return { device };
  }
  return {
    enroll(sessionId) { enrolled.add(sessionId); },
    hasSession: sessionId => enrolled.has(sessionId),
    isDevice,
    observe,
    snapshot(sessionId, snapshot) {
      const s = state(sessionId);
      // Reconstruct only from the supplied window. A high projection cursor
      // does not prove that a truncated window included the current turn's source.
      s.seq = -1; s.turn = null; s.source = null; s.sourceKnown = false; s.deviceSources.clear();
      for (const entry of snapshot?.records ?? []) observe(sessionId, entry?.type === 'event' ? entry.event : entry);
      const seq = snapshot?.projections?.asOfSeq;
      if (Number.isSafeInteger(seq)) s.seq = Math.max(s.seq, seq);
      s.connected = true;
      wake();
    },
    register(key, sessionId) {
      enrolled.add(sessionId);
      const requestId = SOURCE_PREFIX + randomUUID();
      const request = { ...deferred(), key, sessionId, requestId, token: randomUUID(), replies: [], calls: new Map(), settled: false };
      requests.set(requestId, request);
      return request;
    },
    tokenKey(token) { for (const r of requests.values()) if (equalToken(token, r.token)) return r.key; return null; },
    tokenOk(key, token) { return this.tokenKey(token) === key; },
    isPending(requestId) { return requests.has(requestId) && !requests.get(requestId).settled; },
    cancel(requestId, failure = error('DEVICE_REQUEST_CANCELLED', '本轮设备连接已结束。')) {
      const request = requests.get(requestId);
      if (request) settle(request, failure);
      // Keep source/token until turn/end: a late model output must never fall through to QQ.
    },
    discard(requestId, failure) {
      const request = requests.get(requestId);
      if (request) { settle(request, failure); requests.delete(requestId); }
    },
    claim(sessionId, pathname, body, token) {
      const s = state(sessionId);
      const wanted = signature(pathname, body, token);
      const matches = [...s.calls.values()].filter(call => !call.consumed && call.signature === wanted);
      if (!matches.length || matches.some(call => !call.sourceKnown)) throw error('DEVICE_CALL_UNVERIFIED', '无法核对这次工具调用的来源，消息未发送。');
      const origins = new Set(matches.map(call => call.source));
      if (origins.size !== 1) {
        for (const call of matches) call.consumed = true;
        throw error('DEVICE_CALL_AMBIGUOUS', '这次工具调用对应多个来源，消息未发送。');
      }
      const call = matches[0];
      call.consumed = true;
      return { ...call, device: String(call.source ?? '').startsWith(SOURCE_PREFIX) };
    },
    capture(claim, key, messages, voiceStyle) {
      if (!claim?.device) throw error('DEVICE_SOURCE_MISMATCH', '当前调用不是设备请求。');
      const request = requests.get(claim.source);
      if (!request || request.settled || request.key !== key) throw error('DEVICE_REQUEST_CANCELLED', '设备已离线，本轮回复不会发送到 QQ。');
      const text = messages.join('\n');
      const call = [...request.calls].find(([callId, args]) => callId === claim.callId && args?.key === key
        && messageText(args.messages) === text && args.voiceStyle === voiceStyle
        && !request.replies.some(piece => piece.callId === callId));
      if (!call) throw error('DEVICE_CALL_UNVERIFIED', '未能核对正式回复工具调用，未发送任何 QQ 消息。');
      request.replies.push({ text, voiceStyle, callId: call[0], confirmed: false });
      return { ok: true, key, channel: 'device', queued: messages.length, sent: 0, note: '正式回复已交给设备语音服务；本轮结束后合成播放，不发送 QQ。请直接结束本轮，无需 QQ 观望或设置唤醒条件。' };
    },
    async synchronize(sessionId, readProjection) {
      if (!enrolled.has(sessionId)) return;
      const projection = await readProjection();
      if (!Number.isSafeInteger(projection?.asOfSeq)) throw error('DEVICE_SOURCE_UNAVAILABLE', '无法核对当前回复来自哪个回合。');
      const s = state(sessionId);
      if (!s.connected) throw error('DEVICE_EVENTS_UNAVAILABLE', '对话事件连接暂不可用，请稍后重试。');
      if (s.seq < projection.asOfSeq) {
        const d = deferred();
        waiters.add({ ...d, sessionId, seq: projection.asOfSeq });
        await d.promise;
      }
      if (!s.sourceKnown) throw error('DEVICE_SOURCE_UNAVAILABLE', '当前对话窗口缺少回合来源，消息未发送。');
    },
    disconnected() {
      for (const s of sessions.values()) s.connected = false;
      for (const request of requests.values()) settle(request, error('DEVICE_EVENTS_UNAVAILABLE', '对话事件连接已中断，本轮语音未完成。'));
      wake();
    }
  };
}

export function buildSharedDevicePrompt({ key, token, transcript, voiceGuidance }) {
  return [
    '【本轮入口：ESP32 语音设备】同一个用户正在用麦克风与你交谈；继续当前会话的人格、模型和已有上下文。以下为已完成语音识别的文字。',
    `本轮使用 qq_send_message(key=${JSON.stringify(key)}, token=${JSON.stringify(token)}, messages=回复文字, voiceStyle=合适语气) 提交正式语音回复。桥接按真实回合来源把这次工具输出送到设备，不发送到 QQ。`,
    '可以按需使用原有安全网页搜索和记忆能力。普通 final 文本不会朗读。无需 QQ 潜水、等新消息、标记 QQ 已读或设置 QQ 唤醒；答复提交后直接结束本轮。不要调用其他 QQ 发送工具。',
    voiceGuidance ? `【沿用当前语音配置】\n${JSON.stringify(voiceGuidance)}` : '',
    `【用户本轮录音转写】\n${transcript}`
  ].filter(Boolean).join('\n\n');
}
