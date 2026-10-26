// Offline handoff: real MCP callback + real loopback HTTP + real bridge handler.
// MCP registration is a VM fixture; QQ/DSH peers and all runtime files are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function loadWaitTool(temp, port) {
  const tools = new Map();
  const configPath = path.join(temp, 'config.json');
  const fixtureConfig = JSON.stringify({
    consolePort: port,
    consoleToken: 'fixture-console-token',
  });
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));',
      `const __dirname = ${JSON.stringify(path.join(temp, 'src'))};`)
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class FixtureMcpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  const context = vm.createContext({
    McpServer: FixtureMcpServer,
    StdioServerTransport: class {},
    z, URL, URLSearchParams, AbortSignal, Buffer, path, setTimeout, clearTimeout,
    http: {
      request(options, callback) {
        assert.equal(options.hostname, '127.0.0.1');
        assert.equal(Number(options.port), port, 'HTTP may reach only the temporary fixture server');
        assert.equal(options.path, '/api/socialV2/wait');
        return http.request(options, callback);
      },
    },
    console: { log() {}, error() {} },
    // No production configuration/state is reachable from the MCP VM.
    fs: {
      readFileSync(file) {
        assert.equal(path.resolve(String(file)), configPath, 'MCP may read only its in-memory fixture config');
        return fixtureConfig;
      },
    },
    fetch: async () => { assert.fail('wait must use one long poll without a preliminary fetch'); },
    SENSITIVE_RE: { test: () => false },
  });
  // Keep the actual serializer in the same realm as the parsed HTTP response.
  const modelView = fs.readFileSync(new URL('../src/qq-model-view.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '');
  vm.runInContext(modelView, context);
  vm.runInContext(source, context);
  const tool = tools.get('qq_wait_for_messages');
  assert.ok(tool, 'the actual MCP wait handler must be registered');
  return async (arguments_) => {
    const result = await tool.callback(z.object(tool.schema).parse(arguments_));
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
}

test('default MCP wait hands buffered messages and refreshed burst advice through real bridge HTTP', { timeout: 10000 }, async () => {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    burstPlan: { enabled: true, weights: { 1: 1 } },
    proactive: { enabled: false }, sticker: { enabled: false },
  } } });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const append = (text) => h.appendSocialV2Message(
      key, 'fixture-person', text, text, false, false,
      `fixture-${st.lastUnreadSeq + 1}`, [], '789', []
    );
    append('message 1 included in the wake snapshot');
    await h.sendWakePromptV2(key, 'question');
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(st.modelSeenSeqs.has(1), true, 'the delivered snapshot grants a receipt for message 1');
    assert.equal(st.lastReadThroughSeq, 0, 'snapshot visibility is not acknowledgement');

    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const requests = [];
    server.on('request', req => requests.push({ path: req.url, method: req.method }));
    const wait = loadWaitTool(h.temp, server.address().port);
    const waitArguments = { key, token: st.agentToken, timeoutMs: 1200, quietMs: 100 };
    const assertHandoff = (result, seq, advice) => {
      assert.equal(result.ok, true);
      assert.equal(result.purpose, 'messages', 'omitted purpose must use the default MCP path');
      assert.deepEqual(result.newMessages.map(message => message.seq), [seq]);
      assert.equal(result.readThroughSeq, seq);
      assert.equal(result.burstPlanCount, advice);
      assert.equal(result.arrived, true);
      assert.equal(result.quiet, true);
      assert.equal(result.timeout, false);
      assert.ok(result.waitedMs < 600, `already-quiet buffered message waited ${result.waitedMs}ms`);
      assert.equal(result.preSleepWaitObserved, false, 'a pre-request supplement grants no observation');
      assert.equal(result.preSleepWaitSatisfied, false);
      assert.equal(st.preSleepWaitObservedAt, 0);
      assert.equal(st.preSleepWaitSatisfiedAt, 0);
      assert.equal(st.lastReadThroughSeq, 0, 'the MCP/HTTP wait must never acknowledge automatically');
      assert.deepEqual(Array.from(st.unread, message => message.seq), Array.from({ length: seq }, (_, index) => index + 1));
    };

    append('message 2 buffered after the snapshot and before wait');
    st.lastIncomingAt = Date.now() - 200;
    const first = await wait(waitArguments);
    assertHandoff(first, 2, 1);
    assert.equal(requests.length, 1, 'the complete tool handoff uses one HTTP request');

    // Record the existing fixture send completion; no QQ send is performed.
    h.recordSentMessagesV2(key, ['fixture reply closes the first speaking segment']);
    h.cfg.socialV2.burstPlan.weights = { 4: 1 };
    append('message 3 starts a new speaking segment');
    st.lastIncomingAt = Date.now() - 200;
    const second = await wait(waitArguments);
    assertHandoff(second, 3, 4);
    assert.equal(requests.length, 2, 'the second tool call adds only one HTTP request');
    assert.deepEqual(requests, [
      { path: '/api/socialV2/wait', method: 'POST' },
      { path: '/api/socialV2/wait', method: 'POST' },
    ]);
    assert.equal(h.calls.sent.length, 0, 'the handoff fixture must not send QQ messages');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});
