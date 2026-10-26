// Real HTTP send/read handlers with temporary state and fake QQ/DSH peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const replyCases = [
  { name: 'standalone voice', route: 'send-voice', body: { voice: 'fixture.mp3', verify: false }, kind: 'record' },
  { name: 'sticker', route: 'send-sticker', body: { stickerId: 'fixture-sticker' }, kind: 'image' },
  { name: 'poke', route: 'send-poke', body: { targetUserId: '789' }, kind: 'group_poke' },
];

async function fixture({ failSend }, run) {
  const sends = [];
  const h = await bridgeHarness({
    config: { socialV2: {
      burstPlan: { enabled: true, weights: { 1: 1 } },
      tools: { sendVoice: true },
      voice: { enabled: true }, sticker: { enabled: true },
      proactive: { enabled: false },
    } },
    globals: {
      inspectAudio: async () => ({ ok: true, size: 1024, duration: 1, codec: 'fixture', warnings: [] }),
      safeFetchBuffer: async url => {
        assert.equal(url, 'https://public.invalid/sticker');
        return { buffer: Buffer.from('fixture-image') };
      },
      fetch: async (url, init = {}) => {
        const action = String(url).split('/').pop();
        assert.equal(action, 'send_group_msg', 'the fixture must never contact another gateway route');
        const body = JSON.parse(init.body);
        assert.equal(body.group_id, 456);
        const kind = body.message[0]?.type;
        sends.push({ kind, success: !failSend });
        return { ok: true, status: 200, json: async () => failSend
          ? { status: 'failed', retcode: 100, wording: 'fixture rejected send' }
          : { status: 'ok', retcode: 0, data: { message_id: 9001 } } };
      },
    },
  });
  h.setMode('reserved2');
  h.bot.getGroupMemberList = async () => [{ user_id: 789 }];
  h.bot.raw = async (action, body) => {
    assert.equal(action, 'group_poke');
    assert.equal(body.group_id, 456);
    assert.equal(body.user_id, 789);
    sends.push({ kind: action, success: !failSend });
    if (failSend) throw new Error('fixture rejected send');
    return { status: 'ok', retcode: 0, data: {} };
  };
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const audioDir = path.join(h.temp, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, 'fixture.mp3'), Buffer.alloc(1024, 1));
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${key}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', part => { raw += part; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-peer', text, text, false, false,
    `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  try { await run({ h, st, request, append, sends }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

for (const reply of replyCases) {
  test(`successful ${reply.name} reply refreshes advice on the next incoming segment`, () => fixture({ failSend: false }, async ({ h, st, request, append, sends }) => {
    append('first segment');
    assert.equal((await request('unread')).data.burstPlanCount, 1);
    h.cfg.socialV2.burstPlan.weights = { 4: 1 };
    const sent = await request(reply.route, reply.body);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.ok, true);
    assert.deepEqual(sends, [{ kind: reply.kind, success: true }], 'the actual gateway send must succeed');
    assert.equal(st.recentMessages.filter(message => message.isSelf).length, 1);
    append('new incoming after the reply');
    assert.equal((await request('unread')).data.burstPlanCount, 4,
      'a successful non-text reply must finish the previous advice segment');
  }));

  test(`failed ${reply.name} send keeps the current advice for incoming supplements`, () => fixture({ failSend: true }, async ({ h, st, request, append, sends }) => {
    append('first segment');
    assert.equal((await request('unread')).data.burstPlanCount, 1);
    h.cfg.socialV2.burstPlan.weights = { 4: 1 };
    const sent = await request(reply.route, reply.body);
    assert.equal(sent.status, 500, JSON.stringify(sent.data));
    assert.equal(sent.data.ok, false);
    assert.match(sent.data.error, /fixture rejected send/);
    assert.deepEqual(sends, [{ kind: reply.kind, success: false }], 'the failure must occur at the gateway send');
    assert.equal(st.recentMessages.filter(message => message.isSelf).length, 0);
    append('supplement after the failed attempt');
    assert.equal((await request('unread')).data.burstPlanCount, 1,
      'an unsuccessful send must not finish the current advice segment');
  }));
}
