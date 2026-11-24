import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { route, configuredScope } from '../cloudflare/protocol.js';
import { HostedController } from '../cloudflare/controller.js';

const scope = { organizationId: 'org_fixture', projectId: 'prj_fixture', environmentId: 'env_fixture' };
const payload = { contractVersion: 'qagent.ui-runner-dispatch.v1', scope, batchId: 'uieb_fixture' };
const secret = 'dispatch-test-secret-'.repeat(3), token = 'machine-test-token-'.repeat(3);
const env = { UI_RUNNER_DISPATCH_SECRET: secret, UI_RUNNER_SCOPES_JSON: JSON.stringify([{ ...scope, apiUrl: 'https://gateway.fixture.test', token }]) };
function signed(body = payload, { time = Math.floor(Date.now() / 1000), key = secret, path = '/internal/ui-runner/v1/dispatch' } = {}) {
  const text = JSON.stringify(body), digest = createHash('sha256').update(text).digest('hex');
  const signature = createHmac('sha256', key).update(`QAGENT_UI_RUNNER_HTTP_V1\nPOST\n${path}\n${time}\n${digest}`).digest('hex');
  return new Request('https://qagent-ui-runner.internal' + path, { method: 'POST', body: text, headers: { 'X-QAgent-Runner-Time': String(time), 'X-QAgent-Runner-Signature': signature } });
}
function fixture({ stored, running = false, phase = 'IDLE', batchStatus = 'QUEUED', startError = null } = {}) {
  let time = 1000000; const pending = [], values = new Map(stored ? [['job', structuredClone(stored)]] : []), requests = [], starts = [];
  const storage = { alarm: null, async get(k) { return structuredClone(values.get(k)); }, async put(k, v) { values.set(k, structuredClone(v)); }, async setAlarm(v) { this.alarm = v; }, async deleteAlarm() { this.alarm = null; } };
  const container = { running, phase, destroyed: 0, signals: [], timeout: 0,
    start(options) { if (startError) throw startError; starts.push(options); this.running = true; this.phase = 'IDLE'; },
    async setInactivityTimeout(value) { this.timeout = value; }, monitor() { return new Promise(() => {}); },
    signal(value) { this.signals.push(value); this.running = false; }, async destroy() { this.destroyed++; this.running = false; },
    getTcpPort(port) { assert.equal(port, 8080); return { fetch: async request => { requests.push(request); if (this.failProbe) throw new Error('probe failure'); assert.equal(request.headers.get('Authorization'), 'Bearer ' + values.get('job').runtimeToken); if (new URL(request.url).pathname === '/run') this.phase = 'RUNNING'; return Response.json({ batchId: payload.batchId, phase: this.phase, exitCode: this.phase === 'COMPLETED' ? 2 : null, errorCode: this.phase === 'FAILED' ? 'UI_RUNNER_UPLOAD_FAILED' : null }); } }; }
  };
  const ctx = { storage, container, blockConcurrencyWhile(fn) { return fn(); }, waitUntil(p) { pending.push(p); } };
  const deps = { now: () => time, randomToken: () => 'runtime-token-'.repeat(5), fetchImpl: async request => { requests.push(request); if (ctx.gatewayFails) throw new Error('gateway unavailable'); return Response.json({ status: 'ok', data: { batchId: payload.batchId, scope, status: ctx.batchStatus } }); } };
  ctx.batchStatus = batchStatus;
  const controller = new HostedController(ctx, env, deps);
  return { controller, ctx, deps, values, starts, requests, advance(ms) { time += ms; }, replace() { return new HostedController(ctx, env, deps); } };
}
const dispatch = controller => controller.fetch(new Request('http://container-control/dispatch', { method: 'POST', body: JSON.stringify(payload) }));

test('signed dispatch is isolated by scope and routes without sending machine credentials', async () => {
  let routed;
  const response = await route(signed(), { ...env, UI_RUNNER_CONTAINERS: { getByName(id) { assert.match(id, /^[a-f0-9]{64}$/); return { async fetch(request) { routed = await request.json(); return Response.json({ status: 'ok', data: { accepted: true, batchId: routed.batchId } }, { status: 202 }); } }; } } });
  assert.equal(response.status, 202); assert.deepEqual(routed, payload); assert.ok(!JSON.stringify(routed).includes(token));
});

test('dispatch rejects wrong HMAC, expired timestamp, malformed scope and public routing', async () => {
  assert.equal((await route(signed(payload, { key: secret + 'x' }), env)).status, 401);
  assert.equal((await route(signed(payload, { time: Math.floor(Date.now() / 1000) - 301 }), env)).status, 401);
  assert.equal((await route(signed({ ...payload, scope: { ...scope, projectId: ['prj_fixture'] } }), env)).status, 400);
  assert.equal((await route(new Request('https://example.workers.dev/internal/ui-runner/v1/dispatch', signed()), env)).status, 404);
  assert.equal((await route(signed({ ...payload, scope: { ...scope, environmentId: 'env_other' } }), env)).status, 503);
});

test('configuration rejects duplicated scopes and URL credentials', () => {
  const row = JSON.parse(env.UI_RUNNER_SCOPES_JSON)[0];
  assert.throws(() => configuredScope({ UI_RUNNER_SCOPES_JSON: JSON.stringify([row, row]) }, scope), { code: 'UI_RUNNER_SCOPE_CONFIG_DUPLICATED' });
  assert.throws(() => configuredScope({ UI_RUNNER_SCOPES_JSON: JSON.stringify([{ ...row, apiUrl: 'https://secret@gateway.fixture.test' }]) }, scope), { code: 'UI_RUNNER_GATEWAY_URL_INVALID' });
});

test('202 follows durable intent and alarm; duplicate dispatch never launches a second runtime', async () => {
  const f = fixture();
  assert.equal((await dispatch(f.controller)).status, 202);
  assert.equal(f.values.get('job').phase, 'ACCEPTED'); assert.ok(f.ctx.storage.alarm); assert.equal(f.starts.length, 0);
  assert.equal((await dispatch(f.controller)).status, 202);
  await Promise.all([f.controller.alarm(), f.controller.alarm()]);
  assert.equal(f.starts.length, 1); assert.equal(f.controller.state.phase, 'RUNNING');
  assert.equal(f.starts[0].env.QAGENT_TOKEN, token); assert.equal(f.starts[0].env.UI_RUNNER_SCOPES_JSON, undefined);
  assert.equal(f.starts[0].enableInternet, true);
  assert.equal((await dispatch(f.controller)).status, 202); await f.controller.alarm(); assert.equal(f.starts.length, 1);
});

test('lost 202 or Durable Object restart restores intent and protects running work', async () => {
  const f = fixture(); await dispatch(f.controller);
  let restored = f.replace(); await restored.alarm(); assert.equal(f.starts.length, 1);
  f.advance(20 * 60 * 1000); restored = f.replace(); await restored.alarm();
  assert.equal(f.starts.length, 1); assert.equal(f.ctx.container.timeout, 600000); assert.equal(f.ctx.container.signals.length, 0);
  f.ctx.container.failProbe = true; await restored.alarm(); assert.equal(f.ctx.container.signals.length, 0); assert.ok(f.ctx.storage.alarm);
});

test('completed results stop runtime; a redelivery cannot replay a finished batch', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.phase = 'COMPLETED'; f.ctx.batchStatus = 'COMPLETED'; await f.controller.alarm();
  assert.deepEqual(f.ctx.container.signals, [15]); assert.equal(f.controller.state.phase, 'COMPLETED');
  await f.controller.alarm(); assert.equal(f.ctx.storage.alarm, null);
  await dispatch(f.controller); await f.controller.alarm(); assert.equal(f.starts.length, 1);
});

test('runtime failures reconcile Gateway before restart; terminal claims are not reissued here', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.phase = 'FAILED'; await f.controller.alarm(); await f.controller.alarm();
  assert.equal(f.controller.state.phase, 'RECOVERING'); assert.deepEqual(f.ctx.container.signals, [15]);
  f.ctx.batchStatus = 'COMPLETED'; await f.controller.alarm(); assert.equal(f.starts.length, 1); assert.equal(f.controller.state.phase, 'COMPLETED');
});

test('container startup errors keep an alarm and durable intent', async () => {
  const f = fixture({ startError: new Error('no capacity') }); await dispatch(f.controller); await f.controller.alarm();
  assert.equal(f.starts.length, 0); assert.equal(f.values.get('job').phase, 'STARTING'); assert.ok(f.ctx.storage.alarm);
  assert.equal((await dispatch(f.controller)).status, 202);
});

test('already completed Gateway batch never starts a browser container', async () => {
  const f = fixture({ batchStatus: 'COMPLETED' }); await dispatch(f.controller); await f.controller.alarm();
  assert.equal(f.starts.length, 0); assert.equal(f.controller.state.phase, 'COMPLETED');
});

test('a failed control probe only stops work after Gateway authoritatively ended the batch', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.failProbe = true; await f.controller.alarm(); assert.equal(f.ctx.container.signals.length, 0);
  f.ctx.batchStatus = 'COMPLETED'; await f.controller.alarm(); assert.deepEqual(f.ctx.container.signals, [15]);
});

test('a runtime completion without durable Gateway result is not accepted as complete', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.phase = 'COMPLETED'; await f.controller.alarm();
  assert.equal(f.controller.state.phase, 'RUNNING'); assert.equal(f.controller.state.lastError, 'UI_RUNNER_RUNTIME_COMPLETION_UNCONFIRMED');
  assert.equal(f.ctx.container.signals.length, 0); assert.ok(f.ctx.storage.alarm);
});

test('five-minute continuous loss of runtime and Gateway ends compute technically without resetting work', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.failProbe = true; f.ctx.gatewayFails = true; await f.controller.alarm();
  f.advance(299000); await f.controller.alarm(); assert.equal(f.ctx.container.signals.length, 0);
  f.advance(1001); await f.controller.alarm(); assert.deepEqual(f.ctx.container.signals, [15]);
  assert.equal(f.controller.state.lastError, 'UI_RUNNER_INFRASTRUCTURE_UNREACHABLE');
  await f.controller.alarm(); assert.equal(f.controller.state.phase, 'RECOVERING'); await f.controller.alarm(); assert.equal(f.starts.length, 1);
});

test('a successful runtime or Gateway probe resets the double-outage watchdog', async () => {
  const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
  f.ctx.container.failProbe = true; f.ctx.gatewayFails = true; await f.controller.alarm(); f.advance(299000);
  f.ctx.gatewayFails = false; await f.controller.alarm(); assert.equal(f.controller.state.unreachableSince, undefined);
  f.ctx.gatewayFails = true; await f.controller.alarm(); f.advance(299000); await f.controller.alarm(); assert.equal(f.ctx.container.signals.length, 0);
  f.ctx.container.failProbe = false; await f.controller.alarm(); assert.equal(f.controller.state.unreachableSince, undefined);
});

test('terminal runtime is stopped while Gateway is unavailable without declaring the batch complete', async () => {
  for (const phase of ['COMPLETED', 'FAILED']) {
    const f = fixture(); await dispatch(f.controller); await f.controller.alarm();
    f.ctx.container.phase = phase; f.ctx.gatewayFails = true; await f.controller.alarm();
    assert.deepEqual(f.ctx.container.signals, [15]); assert.notEqual(f.controller.state.phase, 'COMPLETED');
    await f.controller.alarm(); assert.equal(f.controller.state.phase, 'RECOVERING');
    await f.controller.alarm(); assert.equal(f.starts.length, 1);
  }
});
