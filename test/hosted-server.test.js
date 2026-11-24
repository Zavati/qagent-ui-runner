import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedRuntime, createHostedServer, authorized } from '../src/hosted-server.js';
import { hostedConfig } from '../src/hosted-config.js';

const config = { batchId: 'uieb_fixture', controlToken: 'runtime-control-'.repeat(4) };
test('runtime starts a batch once; duplicate start preserves execution and actual exit gate', async () => {
  let calls = 0, finish;
  const runtime = new HostedRuntime(config, { workerFactory: async () => ({ async runBatch(id) { assert.equal(id, config.batchId); calls++; return new Promise(resolve => { finish = resolve; }); } }) });
  runtime.start(); runtime.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(runtime.status().phase, 'RUNNING');
  finish({ exitCode: 2 }); await runtime.work;
  assert.equal(runtime.status().phase, 'COMPLETED'); assert.equal(runtime.status().exitCode, 2);
  runtime.start(); assert.equal(calls, 1);
});

test('host interruption remains technical and does not invent a user cancellation', async () => {
  const runtime = new HostedRuntime(config, { log: () => {}, workerFactory: async () => ({ async runBatch(id, { signal }) { return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); } }) });
  runtime.start(); await new Promise(resolve => setImmediate(resolve)); runtime.cancel('UI_RUNNER_HOST_SHUTDOWN'); await runtime.work;
  assert.equal(runtime.status().errorCode, 'UI_RUNNER_HOST_SHUTDOWN'); assert.equal(runtime.status().exitCode, 2);
});

test('runtime control requires exact bearer, refuses body and never returns secrets', () => {
  assert.equal(authorized('Bearer ' + config.controlToken, config.controlToken), true);
  assert.equal(authorized('Bearer ' + config.controlToken + 'x', config.controlToken), false);
  const { server } = createHostedServer(config, { workerFactory: async () => ({ runBatch: async () => ({ exitCode: 2 }) }) });
  function call(method, url, authorization, extra = {}) {
    let status, body; const headers = {};
    server.emit('request', { method, url, headers: { authorization, ...extra }, resume() {} }, { setHeader(k, v) { headers[k] = v; }, writeHead(code) { status = code; }, end(value) { body = value; } });
    return { status, body: JSON.parse(body), headers };
  }
  assert.equal(call('GET', '/status').status, 401);
  const res = call('GET', '/health', 'Bearer ' + config.controlToken);
  assert.equal(res.status, 200); assert.equal(res.body.phase, 'IDLE'); assert.ok(!JSON.stringify(res).includes(config.controlToken));
  assert.equal(call('POST', '/run', 'Bearer ' + config.controlToken, { 'content-length': '50' }).status, 400);
  assert.equal(call('GET', '/files', 'Bearer ' + config.controlToken).status, 404);
  server.close();
});

test('host config requires fixed scope and runtime control credential', () => {
  assert.throws(() => hostedConfig({}), { code: 'UI_RUNNER_HOSTED_SCOPE_REQUIRED' });
  const env = { QAGENT_ORGANIZATION_ID: 'org_fixture', QAGENT_PROJECT_ID: 'prj_fixture', QAGENT_ENVIRONMENT_ID: 'env_fixture', QAGENT_HOSTED_BATCH_ID: 'uieb_fixture', QAGENT_HOSTED_CONTROL_TOKEN: config.controlToken };
  const c = hostedConfig(env); assert.equal(c.port, 8080); assert.equal(c.batchId, 'uieb_fixture');
  assert.throws(() => hostedConfig({ ...env, PORT: '0' }), { code: 'UI_RUNNER_HOSTED_PORT_INVALID' });
});
