// Module: HomeKitUI test harness
// Exercises the actual backend and browser source through isolated host boundaries.
// Uses node:test without a package manifest or installed dependencies.
// HTTP, child-process and HAP boundaries remain isolated from the host.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

class MockServer extends EventEmitter {
  closed = false;

  close(callback) {
    this.closed = true;
    queueMicrotask(callback);
  }
}

class MockApp {
  static instances = [];
  routes = new Map();
  middleware = [];

  use(...args) {
    this.middleware.push(args);
  }

  get(route, handler) {
    this.routes.set('GET ' + route, handler);
  }

  post(route, handler) {
    this.routes.set('POST ' + route, handler);
  }

  listen(...args) {
    this.binding = args.slice(0, -1);
    this.server = new MockServer();
    queueMicrotask(args.at(-1));
    return this.server;
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = {};
  chunks = [];
  ended = false;
  pending = Promise.resolve();

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  json(value) {
    this.body = JSON.parse(JSON.stringify(value));
    return this;
  }

  send(value) {
    this.body = value;
    return this;
  }

  sendFile(file) {
    this.file = file;
    this.pending = fs.readFile(file, 'utf8').then((body) => { this.body = body; });
  }

  write(chunk) {
    this.chunks.push(chunk);
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

const express = () => {
  const app = new MockApp();
  MockApp.instances.push(app);
  return app;
};
express.json = (options) => ({ kind: 'json', options });
express.static = (directory) => ({ kind: 'static', directory });
const qrCalls = [];
const qrcode = { toDataURL: async (uri) => { qrCalls.push(uri); return 'data:image/png;base64,fixture'; } };

// ANSI conversion is a dependency boundary; verify forwarding, not the library's implementation.
class MockAnsiUp {
  ansi_to_html(line) {
    return 'converted:' + line;
  }
}

const processes = [];
function spawn(command, args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.kills = [];
  proc.kill = (signal) => { proc.kills.push(signal); };
  proc.command = command;
  proc.args = args;
  processes.push(proc);
  // Discovery queries resolve deterministically without reading the machine's journal.
  if (command === 'journalctl' && args.includes('-f') === false) {
    queueMicrotask(() => {
      proc.stdout.emit('data', args.includes('json') === true ? '{}' : 'previous run\nlast line');
      proc.emit('close', 0);
    });
  }
  return proc;
}

const moduleURL = new URL('./HomeKitUI.js', import.meta.url).href;
const dependencies = Symbol.for('HomeKitUI.test.dependencies');
const fixtureFs = {
  ...fs,
  readFile: (file, ...args) => file === '/proc/self/cgroup' ? Promise.resolve('') : fs.readFile(file, ...args),
};
globalThis[dependencies] = { express, qrcode, MockAnsiUp, spawn, fs: fixtureFs };
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleURL) {
      const exports = {
        express: 'export default deps.express;',
        qrcode: 'export default deps.qrcode;',
        ansi_up: 'export const AnsiUp = deps.MockAnsiUp;',
        'node:child_process': 'export const spawn = deps.spawn;',
        'node:fs/promises': 'export default deps.fs;',
      };
      if (exports[specifier] !== undefined) {
        const source = 'const deps = globalThis[Symbol.for("HomeKitUI.test.dependencies")];' + exports[specifier];
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
let HomeKitUI;
try {
  ({ default: HomeKitUI } = await import('./HomeKitUI.js'));
} finally {
  resolver.deregister();
  delete globalThis[dependencies];
}

// Console capture is process-wide. Restore methods after this serial suite so the
// harness cannot leave the test runner patched; unique markers isolate history assertions.
const originalConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((key) => [key, console[key]]));
after(() => Object.assign(console, originalConsole));

/**
 * @typedef {object} ServerFixture
 * @property {HomeKitUI} ui Actual runtime instance.
 * @property {MockApp} app Registered routes and middleware, without a socket.
 * @property {string} configFile Disposable configuration file.
 * @property {string} schemaFile Disposable schema file.
 * @property {string} uiSchemaFile Disposable UI schema file.
 * @property {string} directory Temporary fixture directory.
 * @property {function(string, object=): Promise<MockResponse>} request Authenticates and dispatches a request.
 */

/**
 * Creates real temporary JSON files and starts the actual module with fake HTTP boundaries.
 * Cleanup closes streams and removes files even when an assertion fails.
 * @param {import('node:test').TestContext} t Owning serial test.
 * @param {object} [options={}] Host options overriding fixture defaults.
 * @returns {Promise<ServerFixture>} Started fixture.
 */
async function serverFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'homekitui-test-'));
  const configFile = path.join(directory, 'config.json');
  const schemaFile = path.join(directory, 'schema.json');
  const uiSchemaFile = path.join(directory, 'ui-schema.json');
  let ui;
  t.after(async () => {
    try {
      await ui?.stop();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      MockApp.instances.length = 0;
      qrCalls.length = 0;
      processes.length = 0;
    }
  });
  await fs.writeFile(configFile, '{"enabled":true,"zones":[{"name":"Front"}]}');
  await fs.writeFile(schemaFile, '{"type":"object","properties":{"enabled":{"type":"boolean"}}}');
  await fs.writeFile(uiSchemaFile, '{"enabled":{"ui:widget":"checkbox"}}');
  ui = new HomeKitUI({ configFile, schemaFile, uiSchemaFile, logs: { source: 'console' }, ...options });
  assert.equal(await ui.start(), true);
  const app = MockApp.instances.at(-1);
  return {
    ui, app, directory, configFile, schemaFile, uiSchemaFile,
    async request(url, options = {}) {
      const parsed = new URL(url, 'http://fixture');
      const request = new EventEmitter();
      Object.assign(request, {
        path: parsed.pathname.replace(/^\/api/, ''),
        headers: options.headers ?? {}, query: Object.fromEntries(parsed.searchParams),
        body: options.body, params: {},
      });
      const response = new MockResponse();
      response.request = request;
      let allowed = true;
      if (parsed.pathname.startsWith('/api/') === true) {
        allowed = false;
        const auth = app.middleware.find((args) => args[0] === '/api')[1];
        auth(request, response, () => { allowed = true; });
      }
      if (allowed === true) {
        let route = parsed.pathname;
        if (route.startsWith('/api/page/') === true) {
          request.params.id = decodeURIComponent(route.slice('/api/page/'.length));
          route = '/api/page/:id';
        }
        const handler = app.routes.get((options.method ?? 'GET') + ' ' + route) ?? app.middleware.at(-1)[0];
        await handler(request, response);
        await response.pending;
      }
      // Tests explicitly emit finish to check restart ordering rather than silently
      // equating response.json() with a fully flushed HTTP response.
      return response;
    },
  };
}

const post = (body = {}) => ({ method: 'POST', body });
const configOf = async (fixture) => JSON.parse(await fs.readFile(fixture.configFile, 'utf8'));

test('lifecycle uses loopback defaults, adjacent assets, and supports restart after stop', async (t) => {
  const f = await serverFixture(t);
  assert.deepEqual(f.app.binding, [8581, '127.0.0.1']);
  assert.deepEqual(f.app.middleware[0][0], { kind: 'json', options: { limit: '2mb' } });
  assert.equal(f.app.routes.size, 14);
  assert.equal(f.app.middleware.find((args) => args[0]?.kind === 'static')[0].directory,
    path.join(path.dirname(fileURLToPath(moduleURL)), 'ui'));
  const shell = await f.request('/');
  assert.match(shell.body, /id="app"/);
  assert.equal(await f.ui.start(), false);
  assert.equal(await f.ui.stop(), true);
  assert.equal(f.app.server.closed, true);
  assert.equal(await f.ui.stop(), false);
  assert.equal(await f.ui.start({ port: 9000 }), true);
  assert.deepEqual(MockApp.instances.at(-1).binding, [9000, '127.0.0.1']);
});

test('invalid ports disable listening and start-time options can enable it', async () => {
  for (const port of [0, -1, 65536, 'invalid', Infinity]) {
    const ui = new HomeKitUI({ port });
    assert.equal(await ui.start(), false);
    assert.equal(await ui.stop(), false);
  }
  const ui = new HomeKitUI(null);
  try {
    assert.equal(await ui.start({ port: '9001', host: '' }), true);
    assert.deepEqual(MockApp.instances.at(-1).binding, [9001, undefined]);
  } finally {
    await ui.stop();
  }
});

test('info normalises page metadata and exposes uptime, theme and actual UI version', async (t) => {
  const f = await serverFixture(t, {
    name: 'Garden', version: '2', theme: { accent: '#123456' },
    pages: [null, { id: '', title: 'Invalid' }, {
      id: 'zones', title: 'Zones', schemaPath: 'zones', trustedHTML: true,
      restartRequired: false, refreshInterval: '2000', svg: '<svg/>', extra: 'discard',
    }, { id: 'badpath', title: 'Path', schemaPath: '../config' }],
  });
  const info = (await f.request('/api/info')).body;
  assert.equal(info.name, 'Garden');
  assert.equal(info.version, '2');
  assert.equal(info.uiVersion, HomeKitUI.VERSION);
  assert.equal(info.port, 8581);
  assert.equal(typeof info.uptime, 'number');
  assert.deepEqual(info.theme, { accent: '#123456' });
  assert.deepEqual(info.pages, [
    { id: 'zones', title: 'Zones', schemaPath: 'zones', trustedHTML: true,
      restartRequired: false, refreshInterval: 2000, svg: '<svg/>' },
    { id: 'badpath', title: 'Path' },
  ]);
});

test('authentication protects API routes but keeps info and assets public', async (t) => {
  const f = await serverFixture(t, { auth: { enabled: true, bearerToken: ' secret ' } });
  assert.equal((await f.request('/api/info')).statusCode, 200);
  assert.match((await f.request('/')).body, /id="app"/);
  for (const route of ['/api/config', '/api/homekit', '/api/logs', '/api/backup']) {
    const response = await f.request(route);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: 'Authentication required' });
  }
  assert.equal((await f.request('/api/config', { headers: { authorization: 'Bearer secret' } })).statusCode, 200);
  assert.equal((await f.request('/api/config?token=secret')).statusCode, 401);
  assert.equal((await f.request('/api/config', { headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const stream = await f.request('/api/logs/stream?token=secret');
  assert.match(stream.chunks[0], /event: connected/);
  stream.request.emit('close');
});

test('authentication enabled without a token rejects protected requests', async (t) => {
  const f = await serverFixture(t, { auth: { enabled: true } });
  assert.equal((await f.request('/api/config')).statusCode, 401);
  await f.ui.start({ auth: { enabled: 'true', bearerToken: 'secret' } });
  assert.equal((await f.request('/api/config')).statusCode, 200);
});

test('config and schema reads see external edits and optional UI schema may be absent', async (t) => {
  const f = await serverFixture(t);
  assert.equal((await f.request('/api/config')).body.enabled, true);
  await fs.writeFile(f.configFile, '{"enabled":false}');
  assert.deepEqual((await f.request('/api/config')).body, { enabled: false });
  assert.equal((await f.request('/api/schema')).body.type, 'object');
  assert.deepEqual((await f.request('/api/ui-schema')).body, { enabled: { 'ui:widget': 'checkbox' } });
  await f.ui.start({ uiSchemaFile: undefined });
  assert.deepEqual((await f.request('/api/ui-schema')).body, {});
});

test('file read errors return JSON errors and use the host logger', async (t) => {
  const errors = [];
  const f = await serverFixture(t, { log: { error: (message) => errors.push(message) } });
  await fs.writeFile(f.configFile, 'broken');
  assert.equal((await f.request('/api/config')).statusCode, 500);
  await fs.rm(f.configFile);
  assert.match((await f.request('/api/config')).body.error, /ENOENT/);
  await f.ui.start({ schemaFile: undefined });
  assert.match((await f.request('/api/schema')).body.error, /path not configured/);
  assert.equal(errors.length, 3);
});

test('save validates and persists the complete formatted object without a restart flag', async (t) => {
  const validated = [];
  const f = await serverFixture(t, { onValidateConfig: async (config) => { validated.push(config); } });
  const config = { enabled: false, zones: [] };
  assert.deepEqual((await f.request('/api/config', post(config))).body, { ok: true });
  assert.deepEqual(validated, [config]);
  assert.equal(await fs.readFile(f.configFile, 'utf8'), JSON.stringify(config, null, 2) + '\n');
});

test('invalid shapes and rejected validation preserve the file and skip persistence hooks', async (t) => {
  const writes = [];
  const f = await serverFixture(t, {
    onValidateConfig: async () => { throw new Error('Invalid device'); },
    onSaveConfig: async () => writes.push('save'), onRestoreConfig: async () => writes.push('restore'),
  });
  const original = await configOf(f);
  for (const route of ['/api/config', '/api/restore']) {
    for (const body of [[], null, 'text', 42, { enabled: false }]) {
      assert.equal((await f.request(route, post(body))).statusCode, 500);
    }
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(await configOf(f), original);
});

test('save and restore await independent hooks after validation', async (t) => {
  const calls = [];
  const f = await serverFixture(t, {
    onValidateConfig: async () => { await Promise.resolve(); calls.push('validate'); },
    onSaveConfig: async () => { await Promise.resolve(); calls.push('save'); },
    onRestoreConfig: async () => { await Promise.resolve(); calls.push('restore'); },
  });
  const original = await configOf(f);
  await f.request('/api/config', post({ changed: true }));
  assert.deepEqual((await f.request('/api/restore', post({ restored: true }))).body, { ok: true, restartRequired: true });
  assert.deepEqual(calls, ['validate', 'save', 'validate', 'restore']);
  assert.deepEqual(await configOf(f), original);
});

test('backup downloads config and restore uses disk independently of the save hook', async (t) => {
  const save = t.mock.fn(async () => {});
  const f = await serverFixture(t, { onSaveConfig: save });
  const backup = await f.request('/api/backup');
  assert.equal(backup.headers['content-type'], 'application/json');
  assert.match(backup.headers['content-disposition'], /config.backup.json/);
  assert.equal(backup.body.endsWith('\n'), true);
  const original = JSON.parse(backup.body);
  await fs.writeFile(f.configFile, '{}');
  await f.request('/api/restore', post(original));
  assert.deepEqual(await configOf(f), original);
  assert.equal(save.mock.callCount(), 0);
});

test('project data is uncached and unknown IDs never reach the hook', async (t) => {
  const getPage = t.mock.fn(async (id) => ({ type: 'list', items: [{ title: id }] }));
  const f = await serverFixture(t, { pages: [{ id: 'zones', title: 'Zones' }], onGetPage: getPage });
  const response = await f.request('/api/page/zones');
  assert.deepEqual(response.body, { type: 'list', items: [{ title: 'zones' }] });
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal((await f.request('/api/page/unknown')).statusCode, 404);
  assert.equal(getPage.mock.callCount(), 1);
  await f.ui.start({ onGetPage: async () => null });
  assert.deepEqual((await f.request('/api/page/zones')).body, {});
  await f.ui.start({ onGetPage: undefined });
  assert.deepEqual((await f.request('/api/page/zones')).body, {});
});

test('actions validate requests and dispatch only configured pages', async (t) => {
  const onAction = t.mock.fn(async () => { await Promise.resolve(); });
  const f = await serverFixture(t, { pages: [{ id: 'zones', title: 'Zones' }], onAction });
  assert.deepEqual((await f.request('/api/action', post({ action: 'water', data: { zone: 1 }, page: 'zones' }))).body, { ok: true });
  assert.deepEqual(onAction.mock.calls[0].arguments, ['water', { zone: 1 }, 'zones']);
  assert.equal((await f.request('/api/action', post({ action: 'water', page: 'unknown' }))).statusCode, 404);
  for (const body of [[], {}, { action: '' }]) {
    assert.equal((await f.request('/api/action', post(body))).statusCode, 500);
  }
  assert.equal(onAction.mock.callCount(), 1);
  await f.ui.start({ onAction: undefined });
  assert.equal((await f.request('/api/action', post({ action: 'water' }))).statusCode, 501);
});

function accessory(username) {
  return {
    username, displayName: username, setupURI: () => 'X-HM://' + username,
    _accessoryInfo: { pincode: '031-45-154', setupID: 'TEST', paired: () => true,
      listPairings: () => [{ username: 'controller' }] },
  };
}

test('HomeKit reports multiple accessories and preserves first-accessory fields', async (t) => {
  const first = accessory('AA:BB:CC:DD:EE:01');
  const second = accessory('AA:BB:CC:DD:EE:02');
  const f = await serverFixture(t, { accessories: [null, first, undefined, second], accessory: accessory('ignored') });
  const details = (await f.request('/api/homekit')).body;
  assert.equal(details.accessories.length, 2);
  assert.deepEqual(details.accessory, details.accessories[0]);
  assert.equal(details.username, first.username);
  assert.equal(details.accessories[1].username, second.username);
  assert.equal(details.paired, true);
  assert.equal(details.qrCode, 'data:image/png;base64,fixture');
  assert.deepEqual(details.pairings, [{ username: 'controller' }]);
  assert.deepEqual(qrCalls, [first.setupURI(), second.setupURI()]);
});

test('HomeKit handles no accessory, single fallback, unavailable pairings and setup errors', async (t) => {
  const f = await serverFixture(t);
  assert.deepEqual((await f.request('/api/homekit')).body, { accessories: [], paired: false, pairings: [] });
  const single = accessory('single');
  single._accessoryInfo.listPairings = () => { throw new Error('No list'); };
  await f.ui.start({ accessories: null, accessory: single });
  assert.deepEqual((await f.request('/api/homekit')).body.pairings, []);
  single.setupURI = () => { throw new Error('Setup unavailable'); };
  assert.deepEqual((await f.request('/api/homekit')).body, { error: 'Setup unavailable' });
});

test('reset selects the requested accessory and delegates without automatic restart', async (t) => {
  const first = accessory('first');
  const second = accessory('second');
  const reset = t.mock.fn(async () => {});
  const restart = t.mock.fn(async () => {});
  const f = await serverFixture(t, { accessories: [first, second], onResetPairing: reset, onRestart: restart });
  assert.deepEqual((await f.request('/api/homekit/reset', post({ username: 'second' }))).body,
    { ok: true, restartRequired: true });
  assert.deepEqual(reset.mock.calls[0].arguments, ['second', second]);
  assert.equal(restart.mock.callCount(), 0);
});

test('default reset cleans pairing data without teardown and responds before restart', async (t) => {
  const calls = [];
  const single = { username: 'single', unpublish: () => calls.push('unpublish'), destroy: () => calls.push('destroy') };
  const f = await serverFixture(t, {
    accessory: single, hap: { Accessory: { cleanupAccessoryData: (username) => calls.push(['cleanup', username]) } },
    onRestart: async () => calls.push('restart'),
  });
  const handler = f.app.routes.get('POST /api/homekit/reset');
  const response = new MockResponse();
  response.json = (body) => { calls.push(['response', body]); return response; };
  await handler({ body: {} }, response);
  assert.deepEqual(calls, [['cleanup', 'single'], ['response', { ok: true, restartRequired: true }]]);
  response.emit('finish');
  await setImmediate();
  assert.equal(calls.at(-1), 'restart');
});

test('reset uses constructor cleanup fallback and errors when username or cleanup is missing', async (t) => {
  const clean = t.mock.fn();
  const f = await serverFixture(t, { accessory: { username: 'single', constructor: { cleanupAccessoryData: clean } } });
  assert.equal((await f.request('/api/homekit/reset', post())).statusCode, 200);
  assert.deepEqual(clean.mock.calls[0].arguments, ['single']);
  await f.ui.start({ accessory: { username: 'single' } });
  assert.match((await f.request('/api/homekit/reset', post())).body.error, /cleanupAccessoryData/);
  await f.ui.start({ accessory: undefined });
  assert.match((await f.request('/api/homekit/reset', post())).body.error, /no accessory username/);
});

test('restart waits for response finish and logs rejected restart promises', async (t) => {
  const errors = [];
  const f = await serverFixture(t, { log: { error: (message) => errors.push(message) } });
  assert.equal((await f.request('/api/service/restart', post())).statusCode, 501);
  const restart = t.mock.fn(async () => { throw new Error('Restart failed'); });
  await f.ui.start({ onRestart: restart });
  const response = await f.request('/api/service/restart', post());
  assert.deepEqual(response.body, { ok: true, restartRequired: true });
  assert.equal(restart.mock.callCount(), 0);
  response.emit('finish');
  await setImmediate();
  assert.equal(restart.mock.callCount(), 1);
  assert.match(errors[0], /Restart failed/);
});

test('console history and SSE preserve formatted messages, levels and ANSI conversion', async (t) => {
  const f = await serverFixture(t);
  const stream = await f.request('/api/logs/stream');
  console.warn('homekitui-console-fixture %d', 17);
  const logs = (await f.request('/api/logs')).body.logs;
  const entry = logs.find((item) => item.message === 'homekitui-console-fixture 17');
  assert.equal(entry.level, 'warn');
  assert.equal(entry.terminal, entry.message);
  assert.equal(entry.html, 'converted:' + entry.message);
  assert.equal(Number.isNaN(Date.parse(entry.time)), false);
  assert.match(stream.chunks.join(''), /homekitui-console-fixture 17/);
  stream.request.emit('close');
  const length = stream.chunks.length;
  console.info('homekitui-after-stream-close');
  assert.equal(stream.chunks.length, length);
});

test('file history takes priority, tails non-empty lines and surfaces missing files', async (t) => {
  const f = await serverFixture(t);
  const file = path.join(f.directory, 'app.log');
  await fs.writeFile(file, 'first\n\nsecond\nthird\n');
  await f.ui.start({ logs: { source: 'console', file, lines: 2 } });
  const logs = (await f.request('/api/logs')).body.logs;
  assert.deepEqual(logs.map((entry) => entry.message), ['second', 'third']);
  const stream = await f.request('/api/logs/stream');
  const proc = processes.at(-1);
  assert.equal(proc.command, 'tail');
  assert.deepEqual(proc.args, ['-n', '0', '-F', file]);
  proc.stdout.emit('data', 'partial');
  assert.equal(stream.chunks.length, 2);
  proc.stdout.emit('data', ' line\nnext\n');
  assert.match(stream.chunks.join(''), /partial line/);
  stream.request.emit('close');
  assert.deepEqual(proc.kills, ['SIGTERM']);
  assert.equal(stream.ended, true);
  await fs.rm(file);
  assert.equal((await f.request('/api/logs')).statusCode, 500);
});

test('journal history includes the configured unit and stream processes stop on shutdown', async (t) => {
  const f = await serverFixture(t, { logs: { source: 'journald', unit: 'fixture.service', lines: 12 } });
  const logs = (await f.request('/api/logs')).body.logs;
  assert.deepEqual(logs.map((entry) => entry.message), ['previous run', 'last line']);
  assert.deepEqual(processes.at(-1).args, ['-u', 'fixture.service', '-o', 'cat', '-n', '12', '--no-pager']);
  const stream = await f.request('/api/logs/stream');
  const proc = processes.at(-1);
  assert.equal(proc.args.at(-1), '-f');
  proc.stdout.emit('data', 'startup\n');
  assert.match(stream.chunks.join(''), /startup/);
  await f.ui.stop();
  assert.deepEqual(proc.kills, ['SIGTERM']);
  assert.equal(stream.ended, true);
});

test('stream command errors clean up only once', async (t) => {
  const f = await serverFixture(t, { logs: { file: '/fixture/log' } });
  const stream = await f.request('/api/logs/stream');
  const proc = processes.at(-1);
  proc.emit('error', new Error('Command unavailable'));
  proc.emit('close', 1);
  stream.request.emit('close');
  assert.deepEqual(proc.kills, ['SIGTERM']);
  assert.equal(stream.ended, true);
});

// This small DOM boundary records controls and events. It deliberately does not
// parse HTML or simulate browser layout; form commits execute the source handlers.
class MockElement {
  children = [];
  controls = new Map();
  value = '';
  checked = false;
  innerHTML = '';
  style = {};

  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }

  querySelector(selector) {
    if (this.className === 'auth-overlay') {
      if (this.controls.has(selector) === false) {
        const control = new MockElement(selector === '[data-auth-form]' ? 'form' : 'input');
        control.type = 'password';
        this.controls.set(selector, control);
      }
      return this.controls.get(selector);
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
  }

  remove() {
    this.removed = true;
  }
}

/**
 * @typedef {object} BrowserFixture
 * @property {function(string): any} evaluate Executes a test interaction in the script's realm.
 * @property {function(string): any} snapshot Returns a JSON copy of browser state.
 * @property {MockElement} app Recorded shell HTML.
 * @property {MockElement} body Dialog attachment boundary.
 * @property {Map<string, MockElement>} elements Explicitly mounted DOM boundaries.
 * @property {Map<string, string>} storage Browser local-storage boundary.
 * @property {object[]} requests Recorded fetch calls.
 * @property {object} responses Mutable JSON payloads keyed by API path.
 * @property {object[]} streams EventSource instances.
 * @property {Map<number, object>} timers Scheduled timer callbacks, driven by tests.
 * @property {string[]} alerts Recorded user notifications.
 */

/**
 * Executes the unmodified classic script with controlled fetch, DOM, storage and timers.
 * @param {object} [options={}] Response overrides, hash and confirmation result.
 * @returns {Promise<BrowserFixture>} Initialized browser fixture without live timers.
 */
async function browserFixture(options = {}) {
  const script = await fs.readFile(new URL('./ui/app.js', import.meta.url), 'utf8');
  const app = new MockElement('main');
  const body = new MockElement('body');
  const elements = new Map([['app', app]]);
  const storage = new Map();
  const timers = new Map();
  const streams = [];
  const requests = [];
  const alerts = [];
  const events = new Map();
  const styles = new Map();
  const downloads = [];
  let nextTimer = 1;
  const responses = {
    '/api/info': { name: 'Garden', version: '1', uptime: 42, pages: [] },
    '/api/homekit': { accessories: [{ displayName: 'Front', pincode: '031-45-154', paired: true }] },
    '/api/logs': { logs: [{ message: 'Ready', level: 'info' }] },
    '/api/config': { options: { enabled: true, secret: 'keep' }, zones: [{ name: 'Front' }] },
    '/api/schema': { type: 'object', properties: {
      options: { type: 'object', properties: { enabled: { type: 'boolean' }, secret: { type: 'string', format: 'password' } } },
      zones: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', default: 'New' } } } },
    } },
    '/api/ui-schema': {}, ...options.responses,
  };
  const window = {
    location: { hash: options.hash ?? '' },
    URL: {
      createObjectURL: (blob) => { downloads.push({ blob, revoked: false }); return 'blob:fixture'; },
      revokeObjectURL: () => { downloads.at(-1).revoked = true; },
    },
    localStorage: options.localStorage ?? {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener: (event, handler) => events.set('window:' + event, handler),
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay, interval: true }); return id; },
  };
  const document = {
    title: 'HomeKitUI', body, head: new MockElement('head'), activeElement: null,
    documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => new MockElement(tag),
    addEventListener: (event, handler) => events.set('document:' + event, handler),
  };
  class MockEventSource {
    closed = false;

    constructor(url) {
      this.url = url;
      streams.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  let context;
  const fetch = async (url, requestOptions = {}) => {
    requests.push({ path: url, options: JSON.parse(JSON.stringify(requestOptions)) });
    const entry = responses[url];
    const status = entry?.fixtureStatus ?? 200;
    const payload = entry?.fixtureStatus === undefined ? entry ?? { ok: true } : entry.payload;
    return { status, ok: status >= 200 && status < 300,
      blob: async () => new Blob(['fixture backup']),
      json: async () => runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(payload)) + ')', context) };
  };
  context = createContext({ window, document, fetch, EventSource: MockEventSource,
    alert: (message) => alerts.push(String(message)), confirm: () => options.confirm !== false,
    DOMParser: options.DOMParser, structuredClone,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
  runInContext(script, context);
  await setImmediate();
  return {
    app, body, elements, storage, requests, responses, streams, timers, alerts, events, styles, document, downloads,
    evaluate: (expression) => runInContext(expression, context),
    snapshot: (expression) => JSON.parse(runInContext('JSON.stringify(' + expression + ')', context)),
  };
}

test('browser startup loads status, escapes host text, applies theme and starts one stream/timer', async () => {
  const f = await browserFixture({ responses: {
    '/api/info': { name: '<img src=x>', theme: { accent: '#123456' }, pages: [] },
    '/api/homekit': { accessories: [{ displayName: '<img src=x>', pincode: '031-45-154', paired: true }] },
  } });
  assert.deepEqual(f.requests.map((entry) => entry.path), ['/api/info', '/api/homekit', '/api/logs']);
  assert.equal(f.document.title, '<img src=x>');
  assert.match(f.app.innerHTML, /&lt;img src=x&gt;/);
  assert.equal(f.app.innerHTML.includes('<img src=x>'), false);
  assert.match(f.app.innerHTML, /031-45-154/);
  assert.equal(f.styles.get('--accent'), '#123456');
  assert.equal(f.streams.length, 1);
  f.evaluate('startRuntimeTimer(); startLogStream();');
  assert.equal(f.streams.length, 1);
  assert.equal([...f.timers.values()].filter((timer) => timer.interval === true).length, 1);
});

test('browser hash navigation loads project payload and config/schema while preserving model edits', async () => {
  const f = await browserFixture({ responses: { '/api/info': { pages: [{ id: 'zones', title: 'Zones', schemaPath: 'zones' }] } } });
  await f.evaluate('setPage("zones")');
  assert.deepEqual(f.requests.slice(3).map((entry) => entry.path), ['/api/page/zones', '/api/config', '/api/schema', '/api/ui-schema']);
  assert.deepEqual(f.snapshot('state.config.zones'), [{ name: 'Front' }]);
  f.evaluate('setValueAtPath(state.config, ["zones", 0, "name"], "Changed")');
  await f.evaluate('setPage("status")');
  await f.evaluate('setPage("zones")');
  assert.equal(f.snapshot('state.config.zones[0].name'), 'Changed');
  assert.equal(f.requests.filter((entry) => entry.path === '/api/config').length, 1);
});

test('schema controls commit booleans, bounded integers, enums and primitive arrays', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  for (const [schema, value, inputValue, expected] of [
    [{ type: 'integer', minimum: 1, maximum: 10 }, 2, '99.8', 10],
    [{ type: 'integer', minimum: 1, maximum: 10 }, 2, '-3', 1],
    [{ type: 'boolean' }, true, false, false],
    [{ type: 'string', enum: ['auto', 'manual'] }, 'auto', 'manual', 'manual'],
    [{ type: 'boolean', enum: [false, true] }, false, true, true],
    [{ type: 'boolean', enum: [false, true] }, true, false, false],
    [{ type: 'integer', enum: [2, 4] }, 2, 4, 4],
    [{ enum: [1, '1', null] }, 1, '1', '1'],
    [{ enum: [1, '1', null] }, 1, null, null],
  ]) {
    f.evaluate('state.config.field = ' + JSON.stringify(value));
    const container = new MockElement('div');
    // Call the original function with a host-owned DOM boundary and realm-owned schema/path.
    const render = f.evaluate('(container, schema) => renderSchemaField(container, JSON.parse(schema), state.config.field, ["field"])');
    render(container, JSON.stringify(schema));
    const input = container.children.at(-1);
    if (Array.isArray(schema.enum) === true) {
      input.value = String(schema.enum.indexOf(inputValue));
    } else if (schema.type === 'boolean') {
      input.checked = inputValue;
    } else {
      input.value = inputValue;
    }
    input.onchange();
    assert.deepEqual(f.snapshot('state.config.field'), expected);
    assert.equal(f.evaluate('state.changedPaths.has("field")'), true);
  }
  const container = new MockElement('div');
  const render = f.evaluate('(container) => renderPrimitiveArray(container, {items:{type:"integer",minimum:1,maximum:9}}, [], ["pins"])');
  render(container);
  container.children.at(-1).value = '0, 4.8, invalid, 20';
  container.children.at(-1).onblur();
  assert.deepEqual(f.snapshot('state.config.pins'), [1, 4, 9]);
});

test('blank password controls retain existing secrets and replacement is tracked', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  const container = new MockElement('div');
  f.evaluate('(container) => renderSchemaField(container, {type:"string",format:"password"}, state.config.options.secret, ["options","secret"])')(container);
  const input = container.children.at(-1);
  assert.equal(input.value, '');
  assert.equal(input.placeholder, 'Leave unchanged');
  input.onchange();
  assert.equal(f.snapshot('state.config.options.secret'), 'keep');
  assert.equal(f.evaluate('state.changedPaths.size'), 0);
  input.value = 'replacement';
  input.onchange();
  assert.equal(f.snapshot('state.config.options.secret'), 'replacement');
  assert.equal(f.evaluate('state.changedPaths.has("options.secret")'), true);
});

test('schema object arrays add defaults and remove items through their rendered controls', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  f.evaluate('addSchemaItem("zones")');
  assert.deepEqual(f.snapshot('state.config.zones'), [{ name: 'Front' }, { name: 'New' }]);
  const container = new MockElement('div');
  f.evaluate('(container) => renderSchemaArray(container, getSchemaAtPath("zones"), state.config.zones, ["zones"])')(container);
  const firstCard = container.children[0].children[0];
  firstCard.children[0].children[1].onclick();
  assert.deepEqual(f.snapshot('state.config.zones'), [{ name: 'New' }]);
  assert.equal(f.evaluate('state.changedPaths.has("zones")'), true);
});

test('saving sends the complete changed model, adds auth, clears changes and advises restart', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  const before = f.requests.length;
  await f.evaluate('saveConfig()');
  assert.equal(f.requests.length, before);
  f.storage.set('homekitui-token', 'secret');
  f.evaluate('setValueAtPath(state.config, ["options","enabled"], false)');
  await f.evaluate('saveConfig()');
  const saved = f.requests.at(-1);
  assert.equal(saved.path, '/api/config');
  assert.equal(saved.options.method, 'POST');
  assert.equal(saved.options.headers.Authorization, 'Bearer secret');
  assert.equal(saved.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(saved.options.body), { options: { enabled: false, secret: 'keep' }, zones: [{ name: 'Front' }] });
  assert.equal(f.evaluate('state.changedPaths.size'), 0);
  assert.match(f.alerts[0], /Restart required/);
});

test('page and ancestor schema settings suppress restart advice; failed saves retain changes', async () => {
  for (const pageOverride of [true, false]) {
    const f = await browserFixture();
    await f.evaluate('loadConfig(false)');
    if (pageOverride === true) {
      f.evaluate('state.page="settings";state.info.pages=[{id:"settings",restartRequired:false}]');
    } else {
      f.evaluate('state.schema.properties.options.restartRequired=false');
    }
    f.evaluate('setValueAtPath(state.config, ["options","enabled"], false)');
    await f.evaluate('saveConfig()');
    assert.deepEqual(f.alerts, []);
    f.evaluate('setValueAtPath(state.config, ["options","enabled"], true)');
    f.responses['/api/config'] = { fixtureStatus: 500, payload: { error: 'Validation failed' } };
    await f.evaluate('saveConfig()');
    assert.deepEqual(f.alerts, ['Validation failed']);
    assert.equal(f.evaluate('state.changedPaths.has("options.enabled")'), true);
  }
});

test('project lists escape values and HTML pages require explicit trust', async () => {
  const f = await browserFixture();
  f.evaluate('state.page="extra";state.info.pages=[{id:"extra",title:"Extra"}];state.pageData.extra={type:"html",html:"<b>Host</b>"}');
  assert.equal(f.evaluate('projectPage()').includes('<b>Host</b>'), false);
  f.evaluate('state.info.pages[0].trustedHTML=true');
  assert.match(f.evaluate('projectPage()'), /<b>Host<\/b>/);
  f.evaluate('state.pageData.extra={type:"list",items:[{title:"<script>x</script>",subtitle:"<b>Text</b>",value:42}]}');
  const html = f.evaluate('projectPage()');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /42/);
});

test('browser actions send active page and reload its data after success', async () => {
  const f = await browserFixture();
  f.evaluate('state.page="extra";state.info.pages=[{id:"extra",title:"Extra"}]');
  await f.evaluate('sendAction("water", {zone:2})');
  const action = f.requests.find((entry) => entry.path === '/api/action');
  assert.deepEqual(JSON.parse(action.options.body), { action: 'water', data: { zone: 2 }, page: 'extra' });
  assert.equal(f.requests.at(-1).path, '/api/page/extra');
});

test('authentication dialog shares pending requests and persists only remembered tokens', async () => {
  const f = await browserFixture();
  const first = f.evaluate('requestStoredAuthToken()');
  const second = f.evaluate('requestStoredAuthToken()');
  const overlay = f.body.children.at(-1);
  assert.equal(f.body.children.length, 1);
  overlay.querySelector('.auth-input').value = ' session-token ';
  overlay.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await Promise.all([first, second]);
  assert.equal(f.evaluate('authToken()'), 'session-token');
  assert.equal(f.storage.has('homekitui-token'), false);
  assert.equal(overlay.removed, true);
  const remembered = f.evaluate('requestStoredAuthToken()');
  const next = f.body.children.at(-1);
  next.querySelector('.auth-input').value = 'persistent-token';
  next.querySelector('[data-auth-remember]').checked = true;
  next.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await remembered;
  assert.equal(f.storage.get('homekitui-token'), 'persistent-token');
  f.evaluate('clearStoredAuthToken()');
  assert.equal(f.evaluate('authToken()'), '');
});

test('401 retries use submitted credentials and cancellation closes stream and locks UI', async () => {
  const f = await browserFixture();
  f.responses['/api/protected'] = { fixtureStatus: 401, payload: { error: 'Authentication required' } };
  const pending = f.evaluate('api("/api/protected")');
  await setImmediate();
  const overlay = f.body.children.at(-1);
  f.responses['/api/protected'] = { success: true };
  overlay.querySelector('.auth-input').value = 'retry-token';
  overlay.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await pending;
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer retry-token');
  f.responses['/api/protected'] = { fixtureStatus: 401, payload: { error: 'Authentication required' } };
  const cancelled = f.evaluate('api("/api/protected")');
  const rejection = assert.rejects(cancelled, /Authentication required/);
  await setImmediate();
  f.body.children.at(-1).querySelector('[data-auth-cancel]').onclick({ preventDefault() {}, stopPropagation() {} });
  await rejection;
  assert.equal(f.evaluate('state.authRequired'), true);
  assert.equal(f.streams[0].closed, true);
  f.evaluate('render()');
  assert.match(f.app.innerHTML, /Enter the Web UI password/);
});

test('SSE uses query credentials, bounds history and schedules reconnect without real timers', async () => {
  const f = await browserFixture();
  f.streams[0].onerror();
  f.storage.set('homekitui-token', 'token & /');
  const reconnect = [...f.timers.values()].find((timer) => timer.delay === 2000);
  reconnect.callback();
  const stream = f.streams.at(-1);
  assert.equal(stream.url, '/api/logs/stream?token=token%20%26%20%2F');
  for (let i = 0; i < 505; i++) {
    stream.onmessage({ data: JSON.stringify({ message: 'line ' + i, level: 'info' }) });
  }
  stream.onmessage({ data: 'broken' });
  assert.equal(f.evaluate('state.logs.length'), 500);
  assert.equal(f.snapshot('state.logs[0].message'), 'line 5');
  f.evaluate('setAuthRequired(true)');
  assert.equal(stream.closed, true);
});

test('maintenance cancellation avoids writes and confirmed reset targets selected username', async () => {
  const cancelled = await browserFixture({ confirm: false });
  const before = cancelled.requests.length;
  await cancelled.evaluate('restartService(); resetPairing("second")');
  assert.equal(cancelled.requests.length, before);
  const f = await browserFixture();
  await f.evaluate('resetPairing("second")');
  const reset = f.requests.find((entry) => entry.path === '/api/homekit/reset');
  assert.deepEqual(JSON.parse(reset.options.body), { username: 'second' });
});

test('page and action hook failures become JSON errors instead of successful responses', async (t) => {
  const f = await serverFixture(t, {
    pages: [{ id: 'extra', title: 'Extra' }],
    onGetPage: async () => { throw new Error('Page unavailable'); },
    onAction: async () => { throw new Error('Action rejected'); },
  });
  const page = await f.request('/api/page/extra');
  assert.equal(page.statusCode, 500);
  assert.deepEqual(page.body, { error: 'Page unavailable' });
  const action = await f.request('/api/action', post({ action: 'run', page: 'extra' }));
  assert.equal(action.statusCode, 500);
  assert.deepEqual(action.body, { error: 'Action rejected' });
});

test('auto logging falls back to console without a journal unit or invocation', async (t) => {
  const invocation = process.env.INVOCATION_ID;
  delete process.env.INVOCATION_ID;
  t.after(() => {
    if (invocation === undefined) {
      delete process.env.INVOCATION_ID;
    } else {
      process.env.INVOCATION_ID = invocation;
    }
  });
  const f = await serverFixture(t, { logs: { source: 'auto' } });
  const response = await f.request('/api/logs');
  assert.equal(response.statusCode, 200);
  assert.equal(Array.isArray(response.body.logs), true);
  assert.equal(processes.every((proc) => proc.args.includes('json') === true), true);
  const before = processes.length;
  await f.ui.start({ logs: { source: 'file' } });
  assert.equal((await f.request('/api/logs')).statusCode, 200);
  assert.equal(processes.length, before);
});

test('runtime refresh pauses for focused controls, schema pages and authentication lock', async () => {
  const f = await browserFixture();
  const timer = [...f.timers.values()].find((entry) => entry.interval === true);
  f.evaluate('state.page="extra";state.info.pages=[{id:"extra",title:"Extra",refreshInterval:1}];lastStatusPoll=Date.now();lastPageRefresh=0');
  const before = f.requests.length;
  f.document.activeElement = new MockElement('input');
  await timer.callback();
  assert.equal(f.requests.length, before);
  f.document.activeElement = null;
  await timer.callback();
  assert.equal(f.requests.at(-1).path, '/api/page/extra');
  f.evaluate('state.info.pages[0].schemaPath="options";lastPageRefresh=0');
  const schemaCount = f.requests.length;
  await timer.callback();
  assert.equal(f.requests.length, schemaCount);
  f.evaluate('setAuthRequired(true);lastStatusPoll=0');
  await timer.callback();
  assert.equal(f.requests.length, schemaCount);
});

test('delegated navigation and dashboard buttons use data attributes and tolerate malformed payload JSON', async () => {
  const f = await browserFixture();
  f.evaluate('state.info.pages=[{id:"extra",title:"Extra"}]');
  const click = f.events.get('document:click');
  await click({ target: { closest: (selector) => selector === '[data-page]' ? { dataset: { page: 'extra' } } : null } });
  assert.equal(f.snapshot('state.page'), 'extra');
  await click({ target: { closest: (selector) => selector === '[data-send-action]' ?
    { dataset: { sendAction: 'run', payload: '{broken' } } : null } });
  const request = f.requests.find((entry) => entry.path === '/api/action');
  assert.deepEqual(JSON.parse(request.options.body), { action: 'run', data: {}, page: 'extra' });
  f.document.title = 'Extra';
  f.evaluate('window.location.hash="#status"');
  await f.events.get('window:hashchange')();
  assert.equal(f.snapshot('state.page'), 'status');
});

test('log rendering escapes plain messages and paused streams retain history without appending DOM', async () => {
  const f = await browserFixture();
  const logs = new MockElement('div');
  logs.scrollHeight = 100;
  logs.clientHeight = 20;
  f.elements.set('logs', logs);
  f.evaluate('state.logs=[{message:"<script>unsafe</script>",level:"warn onclick=x"}];renderLogsOnly(false)');
  assert.match(logs.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.equal(logs.innerHTML.includes('<script>'), false);
  assert.match(logs.innerHTML, /log-warnonclickx/);
  f.evaluate('togglePause()');
  f.streams[0].onmessage({ data: '{"message":"paused","level":"info"}' });
  assert.equal(logs.children.length, 0);
  assert.equal(f.snapshot('state.logs.at(-1).message'), 'paused');
  f.evaluate('togglePause()');
  assert.match(logs.innerHTML, /paused/);
});

test('save completion preserves edits made during I/O and ignores overlapping save attempts', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  f.evaluate('let saveRequests=[];let resolveSave;fetch=(url,options)=>{saveRequests.push(JSON.parse(options.body));return new Promise(resolve=>{resolveSave=resolve})}');
  f.evaluate('setValueAtPath(state.config,["options","enabled"],false)');
  const saving = f.evaluate('saveConfig()');
  f.evaluate('setValueAtPath(state.config,["zones",0,"name"],"Edited during save")');
  await f.evaluate('saveConfig()');
  assert.equal(f.evaluate('saveRequests.length'), 1);
  assert.equal(f.snapshot('saveRequests[0].zones[0].name'), 'Front');
  f.evaluate('resolveSave({status:200,ok:true,json:async()=>({ok:true})})');
  await saving;
  assert.equal(f.evaluate('state.changedPaths.has("zones.0.name")'), true);
  const latest = f.evaluate('saveConfig()');
  assert.equal(f.snapshot('saveRequests[1].zones[0].name'), 'Edited during save');
  f.evaluate('resolveSave({status:200,ok:true,json:async()=>({ok:true})})');
  await latest;
  assert.equal(f.evaluate('state.changedPaths.size'), 0);
});

test('failed listening rejects startup, releases console capture and permits a later retry', async (t) => {
  const before = console.log;
  const listener = t.mock.method(MockApp.prototype, 'listen', function () {
    this.server = new MockServer();
    queueMicrotask(() => this.server.emit('error', Object.assign(new Error('Port busy'), { code: 'EADDRINUSE' })));
    return this.server;
  });
  const ui = new HomeKitUI();
  t.after(() => ui.stop());
  await assert.rejects(ui.start(), { code: 'EADDRINUSE' });
  assert.equal(console.log, before);
  assert.equal(await ui.stop(), false);
  listener.mock.restore();
  assert.equal(await ui.start(), true);
});

test('pairing reset waits for finish and logs restart errors without another response', async (t) => {
  const errors = [];
  const restart = t.mock.fn(() => { throw new Error('Reset restart failed'); });
  const f = await serverFixture(t, {
    accessory: accessory('single'), hap: { Accessory: { cleanupAccessoryData() {} } },
    onRestart: restart, log: { error: (message) => errors.push(message) },
  });
  const response = await f.request('/api/homekit/reset', post());
  assert.equal(restart.mock.callCount(), 0);
  assert.deepEqual(response.body, { ok: true, restartRequired: true });
  response.emit('finish');
  await setImmediate();
  assert.equal(restart.mock.callCount(), 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, restartRequired: true });
  assert.match(errors[0], /Reset restart failed/);
});

test('restart accepts void hooks and catches synchronous exceptions after finish', async (t) => {
  const errors = [];
  const called = [];
  const f = await serverFixture(t, { log: { error: (message) => errors.push(message) }, onRestart: () => called.push('restart') });
  const response = await f.request('/api/service/restart', post());
  assert.doesNotThrow(() => response.emit('finish'));
  await setImmediate();
  assert.deepEqual(called, ['restart']);
  await f.ui.start({ onRestart: () => { throw new Error('Sync restart failed'); } });
  const failed = await f.request('/api/service/restart', post());
  assert.doesNotThrow(() => failed.emit('finish'));
  await setImmediate();
  assert.match(errors[0], /Sync restart failed/);
});

test('backup 401 requests credentials, retries the binary response and releases its object URL', async () => {
  const f = await browserFixture();
  f.responses['/api/backup'] = { fixtureStatus: 401, payload: { error: 'Authentication required' } };
  const before = f.requests.length;
  const backup = f.evaluate('backupConfig()');
  await setImmediate();
  const overlay = f.body.children.at(-1);
  assert.equal(overlay.className, 'auth-overlay');
  overlay.querySelector('.auth-input').value = 'download-token';
  f.responses['/api/backup'] = { config: true };
  overlay.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await backup;
  assert.deepEqual(f.requests.slice(before).map((entry) => entry.path), ['/api/backup', '/api/backup']);
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer download-token');
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].revoked, true);
  const link = f.body.children.at(-1);
  assert.equal(link.download, 'config.backup.json');
  assert.equal(link.clicked, true);
  assert.equal(link.removed, true);
  assert.deepEqual(f.alerts, []);
});

test('name fields outside array cards commit without throwing', async () => {
  const f = await browserFixture();
  const container = new MockElement('div');
  f.evaluate('(container) => renderSchemaField(container,{type:"string"},"Old",["options","name"])')(container);
  const input = container.children.at(-1);
  input.value = 'New';
  assert.doesNotThrow(() => input.oninput());
  assert.equal(f.snapshot('state.config.options.name'), 'New');
});

test('streams disconnected during source discovery do not install listeners or processes', async (t) => {
  const f = await serverFixture(t);
  for (const source of [{ source: 'console' }, { source: 'file', file: '/fixture/log' }]) {
    await f.ui.start({ logs: source });
    const request = new EventEmitter();
    const response = new MockResponse();
    const opening = f.app.routes.get('GET /api/logs/stream')(request, response);
    response.emit('close');
    request.emit('close');
    await opening;
    const before = response.chunks.length;
    console.info('homekitui-disconnected-regression');
    assert.equal(response.chunks.length, before);
    assert.equal(processes.length, 0);
  }
});

// Minimal SVG tree boundary: tests filtering decisions and serialization only.
class MockSVGElement {
  removed = false;

  constructor(name, attributes = {}, children = []) {
    this.localName = name;
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }));
    this.children = children;
  }

  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
  }

  removeAttribute(name) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }

  remove() {
    this.removed = true;
  }

  get outerHTML() {
    const attributes = this.attributes.map((attribute) => ' ' + attribute.name + '="' + attribute.value + '"').join('');
    return '<' + this.localName + attributes + '>' + this.children.filter((child) => child.removed !== true)
      .map((child) => child.outerHTML).join('') + '</' + this.localName + '>';
  }
}

test('SVG filtering strips root handlers, active elements and remote references while retaining geometry', async () => {
  const root = new MockSVGElement('svg', { onload: 'alert(1)', viewBox: '0 0 24 24', style: 'background:url(https://example.test)' }, [
    new MockSVGElement('script'), new MockSVGElement('animate'), new MockSVGElement('foreignObject'),
    new MockSVGElement('path', { d: 'M0 0h24', onclick: 'alert(2)', fill: 'url(https://example.test)' }),
    new MockSVGElement('use', { href: 'javascript:alert(3)' }),
    new MockSVGElement('use', { href: '#local' }),
    new MockSVGElement('rect', { fill: 'url(#local)', width: '12', height: '12' }),
  ]);
  class DOMParser {
    parseFromString() {
      return { querySelector: (selector) => selector === 'svg' ? root : null };
    }
  }
  const f = await browserFixture({ DOMParser });
  const html = f.evaluate('icon({svg:"<svg/>"})');
  assert.equal(/onload|onclick|script|animate|foreignObject|javascript|https:|style=/.test(html), false);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /d="M0 0h24"/);
  assert.match(html, /href="#local"/);
  assert.match(html, /fill="url\(#local\)"/);
});

test('default reset rejects unconfigured usernames without invoking cleanup', async (t) => {
  const cleanup = t.mock.fn();
  const f = await serverFixture(t, { accessory: accessory('configured'), hap: { Accessory: { cleanupAccessoryData: cleanup } } });
  const response = await f.request('/api/homekit/reset', post({ username: 'unconfigured' }));
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'Unknown accessory username' });
  assert.equal(cleanup.mock.callCount(), 0);
});

test('atomic writes retain permissions and preserve the previous config when rename fails', async (t) => {
  const f = await serverFixture(t);
  await fs.chmod(f.configFile, 0o640);
  const original = await fs.readFile(f.configFile, 'utf8');
  const rename = t.mock.method(fixtureFs, 'rename', async () => { throw new Error('Rename failed'); });
  const failed = await f.request('/api/config', post({ changed: true }));
  assert.equal(failed.statusCode, 500);
  assert.equal(await fs.readFile(f.configFile, 'utf8'), original);
  assert.equal((await fs.readdir(f.directory)).some((name) => name.startsWith('.homekitui-')), false);
  rename.mock.restore();
  assert.equal((await f.request('/api/config', post({ changed: true }))).statusCode, 200);
  assert.deepEqual(await configOf(f), { changed: true });
  assert.equal((await fs.stat(f.configFile)).mode & 0o777, 0o640);
});

test('atomic config writes follow existing symlinks without replacing the link', async (t) => {
  const f = await serverFixture(t);
  const target = path.join(f.directory, 'target.json');
  await fs.rename(f.configFile, target);
  await fs.symlink(target, f.configFile);
  assert.equal((await f.request('/api/config', post({ changed: true }))).statusCode, 200);
  assert.equal((await fs.lstat(f.configFile)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { changed: true });
});

test('save and restore serialize host persistence and recover after rejection', async (t) => {
  const calls = [];
  let release;
  const f = await serverFixture(t, {
    onValidateConfig: (config) => calls.push('validate ' + config.order),
    onSaveConfig: async () => { calls.push('save start'); await new Promise((resolve) => { release = resolve; }); throw new Error('Save failed'); },
    onRestoreConfig: async () => calls.push('restore'),
  });
  const save = f.request('/api/config', post({ order: 1 }));
  // Wait for real filesystem path resolution rather than assuming one microtask is enough.
  while (release === undefined) {
    await setImmediate();
  }
  const restore = f.request('/api/restore', post({ order: 2 }));
  await setImmediate();
  assert.deepEqual(calls, ['validate 1', 'save start']);
  release();
  assert.equal((await save).statusCode, 500);
  assert.equal((await restore).statusCode, 200);
  assert.deepEqual(calls, ['validate 1', 'save start', 'validate 2', 'restore']);
});

test('single-instance console capture bounds history and restores methods on stop', async (t) => {
  const before = console.info;
  const f = await serverFixture(t, { logs: { source: 'console', lines: 1 } });
  assert.notEqual(console.info, before);
  console.info('homekitui-history-first');
  console.info('homekitui-history-last');
  assert.deepEqual((await f.request('/api/logs')).body.logs.map((entry) => entry.message), ['homekitui-history-last']);
  await f.ui.stop();
  assert.equal(console.info, before);
  await f.ui.start();
  assert.notEqual(console.info, before);
  const response = new MockResponse();
  await MockApp.instances.at(-1).routes.get('GET /api/logs')({}, response);
  assert.deepEqual(response.body.logs, []);
  await f.ui.stop();
  assert.equal(console.info, before);
});

test('file history and unterminated stream lines are bounded', async (t) => {
  const f = await serverFixture(t);
  const file = path.join(f.directory, 'large.log');
  await fs.writeFile(file, 'x'.repeat(2 * 1024 * 1024) + '\nlatest\n');
  await f.ui.start({ logs: { file, lines: 500 } });
  const logs = (await f.request('/api/logs')).body.logs;
  assert.deepEqual(logs.map((entry) => entry.message), ['latest']);
  const stream = await f.request('/api/logs/stream');
  const proc = processes.at(-1);
  proc.stdout.emit('data', 'x'.repeat(1024 * 1024));
  proc.stdout.emit('data', '\n');
  const record = JSON.parse(stream.chunks.at(-1).slice('data: '.length));
  assert.equal(record.message.length, 16384);
  stream.request.emit('close');
});

test('backpressure disconnects slow clients and stops their producer', async (t) => {
  const f = await serverFixture(t, { logs: { file: '/fixture/log' } });
  const stream = await f.request('/api/logs/stream');
  const proc = processes.at(-1);
  stream.write = () => false;
  proc.stdout.emit('data', 'first\nsecond\n');
  assert.equal(stream.destroyed, true);
  assert.deepEqual(proc.kills, ['SIGTERM']);
  assert.equal(stream.ended, true);
});

test('cancelled backup authentication locks the shell without downloading', async () => {
  const f = await browserFixture();
  f.responses['/api/backup'] = { fixtureStatus: 401, payload: { error: 'Authentication required' } };
  const backup = f.evaluate('backupConfig()');
  await setImmediate();
  f.body.children.at(-1).querySelector('[data-auth-cancel]').onclick({ preventDefault() {}, stopPropagation() {} });
  await backup;
  assert.match(f.app.innerHTML, /Enter the Web UI password/);
  assert.equal(f.evaluate('state.authRequired'), true);
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.downloads.length, 0);
});

test('server errors after listening are logged without escaping the host', async (t) => {
  const errors = [];
  const f = await serverFixture(t, { log: { error: (message) => errors.push(message) } });
  assert.doesNotThrow(() => f.app.server.emit('error', new Error('Runtime listener error')));
  assert.match(errors[0], /Runtime listener error/);
  assert.equal(await f.ui.stop(), true);
});

test('default persistence creates missing configuration with private permissions', async (t) => {
  const f = await serverFixture(t);
  await fs.rm(f.configFile);
  assert.equal((await f.request('/api/config', post({ created: true }))).statusCode, 200);
  assert.deepEqual(await configOf(f), { created: true });
  assert.equal((await fs.stat(f.configFile)).mode & 0o777, 0o600);
});

test('cached console method references remain callable after capture is released', async (t) => {
  const f = await serverFixture(t);
  const captured = console.info;
  await f.ui.stop();
  assert.doesNotThrow(() => captured('homekitui-cached-console-regression'));
});

test('new array items own nested defaults without mutating siblings or schema', async () => {
  const f = await browserFixture();
  await f.evaluate('loadConfig(false)');
  f.evaluate('state.config.zones = []; state.schema.properties.zones.items.default = {name:"New",settings:{pins:[1,2]}}');
  f.evaluate('addSchemaItem("zones"); addSchemaItem("zones")');
  f.evaluate('setValueAtPath(state.config, ["zones",0,"name"], "Edited"); state.config.zones[0].settings.pins.push(3)');
  assert.deepEqual(f.snapshot('state.config.zones[1]'), { name: 'New', settings: { pins: [1, 2] } });
  assert.deepEqual(f.snapshot('state.schema.properties.zones.items.default'), { name: 'New', settings: { pins: [1, 2] } });
  assert.equal(f.evaluate('state.changedPaths.has("zones.0.name")'), true);
});

test('structured enum defaults and committed values do not alias the schema', async () => {
  const f = await browserFixture();
  f.evaluate('state.schema.choice = {enum:[{name:"New"}]}');
  f.evaluate('let enumDefault = getDefaultValue(state.schema.choice); enumDefault.name = "Changed"');
  assert.equal(f.evaluate('state.schema.choice.enum[0].name'), 'New');
  const container = new MockElement('div');
  f.evaluate('(container) => renderSchemaField(container, state.schema.choice, undefined, ["choice"])')(container);
  container.children.at(-1).value = '0';
  container.children.at(-1).onchange();
  f.evaluate('state.config.choice.name = "Edited"');
  assert.equal(f.evaluate('state.schema.choice.enum[0].name'), 'New');
});

test('denied storage leaves startup, API requests and session preferences usable', async () => {
  const f = await browserFixture({ localStorage: {
    getItem() { throw new Error('Storage denied'); },
    setItem() { throw new Error('Storage denied'); },
    removeItem() { throw new Error('Storage denied'); },
  } });
  assert.equal(f.evaluate('state.error'), undefined);
  assert.equal(f.streams.length, 1);
  await f.evaluate('api("/api/config")');
  assert.equal(f.requests.at(-1).path, '/api/config');
  assert.equal(f.evaluate('writeBrowserStorage("homekitui-collapse-dashboard-panel", "true")'), false);
  assert.equal(f.evaluate('readBrowserStorage("homekitui-collapse-dashboard-panel")'), 'true');
  assert.equal(f.evaluate('writeBrowserStorage("homekitui-visible-dashboard-group", "selected")'), false);
  assert.equal(f.evaluate('readBrowserStorage("homekitui-visible-dashboard-group")'), 'selected');
  f.evaluate('render()');
});

test('denied token persistence retries authentication and reports tab-only credentials', async () => {
  const f = await browserFixture();
  f.evaluate('window.localStorage.setItem = () => { throw new Error("Storage full"); }');
  f.responses['/api/protected'] = { fixtureStatus: 401, payload: { error: 'Authentication required' } };
  const pending = f.evaluate('api("/api/protected")');
  await setImmediate();
  const overlay = f.body.children.at(-1);
  overlay.querySelector('.auth-input').value = 'tab-token';
  overlay.querySelector('[data-auth-remember]').checked = true;
  f.responses['/api/protected'] = { success: true };
  overlay.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await pending;
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer tab-token');
  assert.equal(f.evaluate('authToken()'), 'tab-token');
  assert.equal(f.storage.has('homekitui-token'), false);
  assert.match(f.alerts.at(-1), /kept for this tab only/);
});

test('denied token removal cannot resurrect stale remembered credentials', async () => {
  const f = await browserFixture();
  f.storage.set('homekitui-token', 'stale-token');
  assert.equal(f.evaluate('authToken()'), 'stale-token');
  f.evaluate('window.localStorage.removeItem = () => { throw new Error("Removal denied"); }');
  f.evaluate('clearStoredAuthToken()');
  assert.equal(f.evaluate('authToken()'), '');
  assert.equal(f.storage.get('homekitui-token'), 'stale-token');
  const pending = f.evaluate('requestStoredAuthToken()');
  const overlay = f.body.children.at(-1);
  overlay.querySelector('.auth-input').value = 'new-session-token';
  overlay.querySelector('[data-auth-form]').onsubmit({ preventDefault() {}, stopPropagation() {} });
  await pending;
  assert.equal(f.evaluate('authToken()'), 'new-session-token');
  f.evaluate('clearStoredAuthToken()');
  assert.equal(f.evaluate('authToken()'), '');
});

test('failed page loads preserve the last payload and render an actionable error', async () => {
  const f = await browserFixture({ responses: {
    '/api/info': { pages: [{ id: 'dashboard', title: 'Dashboard' }] },
    '/api/page/dashboard': { type: 'list', items: [{ title: 'Known state' }] },
  } });
  await f.evaluate('setPage("dashboard")');
  const previous = f.snapshot('state.pageData.dashboard');
  f.responses['/api/page/dashboard'] = { fixtureStatus: 500, payload: { error: 'Host page failed' } };
  await f.evaluate('setPage("dashboard")');
  assert.deepEqual(f.snapshot('state.pageData.dashboard'), previous);
  assert.match(f.app.innerHTML, /Host page failed/);
  assert.match(f.app.innerHTML, /Known state/);
  f.responses['/api/page/dashboard'] = { type: 'list', items: [{ title: 'Recovered state' }] };
  await f.evaluate('setPage("dashboard")');
  assert.equal(f.evaluate('state.error'), undefined);
  assert.match(f.app.innerHTML, /Recovered state/);
});

test('transport failures preserve page payload and authentication cancellation still rejects', async () => {
  const f = await browserFixture();
  f.evaluate('state.pageData.dashboard = {type:"list",items:[{title:"Known state"}]}');
  f.evaluate('fetch = async () => { throw new Error("Network offline"); }');
  await f.evaluate('loadPageData("dashboard")');
  assert.equal(f.evaluate('state.pageData.dashboard.items[0].title'), 'Known state');
  assert.equal(f.evaluate('state.error'), 'Network offline');
  f.evaluate('fetch = async () => ({status:401})');
  const pending = f.evaluate('loadPageData("dashboard")');
  const rejection = assert.rejects(pending, /Authentication required/);
  await setImmediate();
  f.body.children.at(-1).querySelector('[data-auth-cancel]').onclick({ preventDefault() {}, stopPropagation() {} });
  await rejection;
  assert.equal(f.evaluate('state.authRequired'), true);
  assert.equal(f.evaluate('state.pageData.dashboard.items[0].title'), 'Known state');
});
