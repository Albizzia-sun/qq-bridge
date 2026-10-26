import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { NodeApiClient, mintBrowserSessionCookie } from '../src/dsh-client.js';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static sockets = [];
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.frames = [];
    FakeWebSocket.sockets.push(this);
  }
  send(frame) { this.frames.push(JSON.parse(frame)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
}

test('changing the DSH port clears authority-bound auth and reconnects existing sessions', async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  const client = new NodeApiClient('http://127.0.0.1:3080');
  const secret = Buffer.alloc(32, 7);
  client.browserSessionSecret = () => secret;
  client.events.follow('existing-qq-session');
  const stream = client.events.mux({})[Symbol.asyncIterator]();
  const oldNext = stream.next();
  try {
    await new Promise(setImmediate);
    const oldSocket = FakeWebSocket.sockets.at(-1);
    oldSocket.open();
    const oldCookie = client.cookie;
    assert.ok(oldCookie);
    assert.equal(client.setBaseUrl('http://127.0.0.1:41000/'), true);
    assert.equal(client.cookie, null);
    assert.equal((await oldNext).done, true);
    assert.equal(oldSocket.readyState, FakeWebSocket.CLOSED);
    const controller = new AbortController();
    const nextStream = client.events.mux({}, controller.signal)[Symbol.asyncIterator]();
    const next = nextStream.next();
    await new Promise(setImmediate);
    const newSocket = FakeWebSocket.sockets.at(-1);
    newSocket.open();
    assert.equal(newSocket.url, 'ws://127.0.0.1:41000/api/remote.mux');
    assert.notEqual(client.cookie, oldCookie);
    assert.deepEqual(newSocket.frames.filter(f => f.endpoint === 'session/follow')
      .map(f => f.payload.args.request.address.sessionId), ['existing-qq-session']);
    assert.equal(newSocket.frames.filter(f => f.endpoint === '$events').length, 1);
    assert.equal(client.setBaseUrl('http://127.0.0.1:41000'), false);
    assert.equal(newSocket.readyState, FakeWebSocket.OPEN);
    controller.abort();
    await next;
  } finally {
    FakeWebSocket.sockets.forEach(socket => socket.close());
    await oldNext;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('desktop restart recovery verifies the new API and also works from stale startup config', async t => {
  const { checkDshConnection } = await import('../src/dsh-desktop.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-reconnect-'));
  const previousHome = process.env.DSH_HOME;
  const secret = Buffer.alloc(32, 9);
  fs.writeFileSync(path.join(home, '.credentials.yaml'), JSON.stringify({ records: {
    'client-connection/browser-session': { kind: 'grant', payload: { version: 1, secret: secret.toString('base64url') } }
  } }));
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const serve = async (ok = true) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      // A stale port's cookie must not authenticate on the new authority.
      const cookieName = mintBrowserSessionCookie(`http://${req.headers.host}`, secret).split('=')[0];
      const authenticated = req.headers.cookie?.startsWith(`${cookieName}=`);
      res.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
        result: ok ? { ok: true, value: {} } : { ok: false, error: { code: 'unavailable', message: 'starting' } } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  const old = await serve();
  const current = await serve();
  const notReady = await serve(false);
  const client = new NodeApiClient(old.url, 1000);
  let candidates = [];
  let discoveries = 0;
  const options = { desktopExecutable: 'C:\\DeepSeek Harness\\DeepSeek Harness.exe',
    discover: async () => { discoveries++; return candidates; } };
  assert.equal((await checkDshConnection(client, options)).ready, true);
  assert.equal(discoveries, 0, 'healthy connections do not poll Windows processes');
  old.server.closeAllConnections();
  await new Promise(resolve => old.server.close(resolve));
  assert.equal((await checkDshConnection(client, options)).ready, false, 'closed DSH stays offline');
  assert.equal(client.baseUrl, old.url);
  candidates = [notReady.url];
  assert.equal((await checkDshConnection(client, options)).ready, false);
  assert.equal(client.baseUrl, old.url, 'unready candidates do not replace the current URL');
  candidates = [current.url, notReady.url];
  assert.equal((await checkDshConnection(client, options)).ready, false, 'ambiguous listeners are not guessed');
  candidates = [current.url];
  const result = await checkDshConnection(client, options);
  assert.equal(result.ready, true);
  assert.equal(result.previousBaseUrl, old.url);
  assert.equal(client.baseUrl, current.url);
  assert.equal((await client.settings.describe({})).result.ok, true);
  const afterBridgeRestart = new NodeApiClient(old.url, 1000);
  assert.equal((await checkDshConnection(afterBridgeRestart, options)).ready, true);
  assert.equal(afterBridgeRestart.baseUrl, current.url);
  const disabled = new NodeApiClient(old.url, 1000);
  const before = discoveries;
  assert.equal((await checkDshConnection(disabled, { discover: options.discover })).ready, false);
  assert.equal(discoveries, before, 'fixed URL configurations keep their behavior');
  const remote = { baseUrl: 'https://example.invalid', settings: { describe: async () => { throw Error('offline'); } } };
  assert.equal((await checkDshConnection(remote, options)).ready, false);
  assert.equal(discoveries, before, 'remote configurations are never redirected to local DSH');
});

test('Windows discovery only returns valid loopback listeners and passes paths as data', async () => {
  const { discoverDesktopBaseUrls } = await import('../src/dsh-desktop.js');
  const executable = "C:\\DSH's folder\\DeepSeek Harness.exe";
  let calls = 0;
  const run = async (_file, args, options) => {
    calls++;
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.QQ_BRIDGE_DSH_DESKTOP_EXE, executable);
    assert.ok(!args.join(' ').includes(executable));
    return { stdout: JSON.stringify([
      { LocalAddress: '127.0.0.1', LocalPort: 41000 },
      { LocalAddress: '127.0.0.1', LocalPort: 41000 },
      { LocalAddress: '0.0.0.0', LocalPort: 42000 },
      { LocalAddress: '127.0.0.1', LocalPort: 0 }
    ]) };
  };
  assert.deepEqual(await discoverDesktopBaseUrls(executable, { platform: 'win32', run }), ['http://127.0.0.1:41000']);
  assert.deepEqual(await discoverDesktopBaseUrls(executable, { platform: 'linux', run }), []);
  assert.equal(calls, 1);
});

test('port migration cancels old HTTP work instead of replaying it on another host', async () => {
  const originalFetch = globalThis.fetch;
  const client = new NodeApiClient('http://127.0.0.1:3080');
  client.browserSessionSecret = () => Buffer.alloc(32, 6);
  let requestSignal;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
  };
  try {
    const pending = client.doFetch('http://127.0.0.1:3080/api/session/prompt', { method: 'POST' });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await new Promise(setImmediate);
    client.setBaseUrl('http://127.0.0.1:41000');
    assert.equal(requestSignal?.aborted, true);
    await rejected;
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
