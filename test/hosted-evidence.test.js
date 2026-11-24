import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidencePublisher } from '../src/evidence-publisher.js';
import { Ledger, readCollection } from '../src/ledger.js';
import { Worker } from '../src/worker.js';
import { UiRunner, technicalPair } from '../src/engine.js';
import { resolvePreparation, validateProfile } from '../src/preparation.js';
import { NetworkController } from '../src/network.js';
import { ArtifactStore } from '../src/source.js';
import { RunnerError, sha256, OriginBinding } from '../src/core.js';
import { fixture } from './fixture.js';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-hosted-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('small report pages become publishable before mode completion and retain every row once', async t => {
  const directory = await temporary(t), uploaded = [];
  const ledger = new Ledger('UI_LIVE', directory, { flushIntervalMs: 5, onEvidence: async (ref, bytes, path) => uploaded.push({ ref, bytes, path }) });
  await ledger.check('FIELD', 'PASSED', null, 'expected', 'expected');
  for (let i = 0; i < 50 && !uploaded.length; i++) await sleep(5);
  assert.equal(uploaded.length, 1, 'a small live report must not wait until the whole mode ends');
  await ledger.check('FIELD', 'FAILED', null, 'one', 'two');
  const result = await ledger.finish(), rows = await readCollection(result, 'checks', directory);
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(r => r.id)).size, 2);
  assert.equal(uploaded.reduce((n, x) => n + x.ref.count, 0), 2);
  assert.deepEqual(await readFile(uploaded[0].path), uploaded[0].bytes);
});
test('progressive evidence uses persisted paths, does not stall browser append, retries transport only', async t => {
  const directory = await temporary(t), bytes = Buffer.from('kept on disk'), path = join(directory, 'one.bin'); await writeFile(path, bytes);
  const ref = { evidenceId: 'uire_sample', sha256: sha256(bytes), byteLength: bytes.length, contentType: 'application/octet-stream' };
  let calls = 0, release;
  const publisher = new EvidencePublisher({ async evidence(_claim, got, body) {
    calls++; assert.deepEqual(got, ref); assert.deepEqual(body, bytes);
    if (calls === 1) { await new Promise(resolve => { release = resolve; }); throw new RunnerError('UI_RUNNER_TRANSPORT_TIMEOUT'); }
    return ref;
  } }, { batchId: 'uieb_sample', itemId: 'uiebi_sample' });
  publisher.enqueue(ref, null, path); publisher.enqueue(ref, null, path);
  for (let i = 0; i < 50 && !release; i++) await sleep(2);
  assert.equal(calls, 1, 'same immutable evidence is not uploaded in parallel twice');
  release(); await publisher.drain(); assert.equal(calls, 2);
  await publisher.drain(); assert.equal(calls, 2, 'receipt must be reused');
});
test('Worker publishes during execution and waits for evidence receipts before result commit', async t => {
  const directory = await temporary(t), f = fixture(), order = []; let reachedBrowser = 0;
  const fakeClient = {
    async source() { return f.response; },
    async heartbeat() { return { leaseExpiresAt: Date.now() + 90000, cancelRequested: false }; },
    async evidence(_claim, ref) { order.push('evidence:' + ref.evidenceId); },
    async result(_claim, pair) { assert.ok(pair.evidence.every(ref => order.includes('evidence:' + ref.evidenceId))); order.push('result'); return { status: 'COMPLETED' }; },
  };
  const worker = new Worker({ client: fakeClient, directory, log() {}, engineFactory: options => ({ async runPair() {
    reachedBrowser++;
    const ledger = new Ledger('UI_REPLAY', options.outputDirectory, { onEvidence: options.onEvidence, pageBytes: 1 });
    await ledger.check('EXECUTED', 'PASSED', null, 1, 1); await ledger.finish();
    for (let i = 0; i < 50 && !order.length; i++) await sleep(2);
    assert.ok(order.length, 'progress must leave the container while the engine is still running');
    order.push('engine-done'); return technicalPair(f.claim, 'UI_RUNNER_TEST_PENDING', options.outputDirectory, options.onEvidence);
  } }) });
  await worker.executeClaim(f.claim); assert.equal(reachedBrowser, 1);
  assert.ok(order[0].startsWith('evidence:')); assert.equal(order.at(-1), 'result');
});
test('UNAUTHENTICATED is opt-in and never declares login, seed, or target build verified', async () => {
  const f = fixture(), config = { preparations: {}, directory: process.cwd() };
  await assert.rejects(resolvePreparation(config, f.profile, 'UI_LIVE'), { code: 'UI_RUNNER_PREPARATION_NOT_CONFIGURED' });
  const profile = { ...f.profile, preparationMode: 'UNAUTHENTICATED' };
  validateProfile(profile, f.claim.scope);
  const preparation = await resolvePreparation(config, profile, 'UI_LIVE');
  assert.equal(preparation.storageState, undefined);
  assert.deepEqual(await preparation.run(), { ready: false, baselineReady: false, verifiedTargetBuildRef: null, liveStatePrepared: false });
  assert.ok(preparation.pendingReasons.includes('UI_RUNNER_AUTHENTICATION_NOT_CONFIGURED'));
  assert.throws(() => validateProfile({ ...profile, preparationMode: 'BYPASS' }, f.claim.scope), { code: 'UI_RUNNER_PREPARATION_MODE_INVALID' });
});
test('unconfigured authentication still launches both modes and preserves real navigation failures', async t => {
  const directory = await temporary(t), f = fixture(); f.claim.profile.preparationMode = 'UNAUTHENTICATED';
  const contexts = [], visited = [];
  const runner = new UiRunner({ outputDirectory: directory, browserLauncher: async () => ({
    async newContext(options) {
      assert.equal(options.storageState, undefined);
      const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {}, async route() {}, async unroute() {}, async routeWebSocket() {}, async close() {},
        tracing: { async start() {}, async stop({ path }) { await writeFile(path, 'synthetic browser trace'); } },
        async newPage() { return { async close() {}, async goto(url) { visited.push(url); throw new RunnerError('UI_RUNNER_AUTHENTICATION_REQUIRED'); }, async screenshot() { return Buffer.from('synthetic screenshot'); } }; },
      };
      contexts.push(context); return context;
    }, async close() {},
  }) });
  const result = await runner.runPair({ claim: f.claim, sourceResponse: f.response, readArtifact: async id => f.bytes.get(id) });
  assert.equal(contexts.length, 2); assert.notEqual(contexts[0], contexts[1]); assert.equal(visited.length, 2);
  assert.equal(result.executionPerformed, true);
  for (const mode of result.modes) {
    assert.equal(mode.status, 'FAILED'); assert.equal(mode.executionPerformed, true);
    assert.ok(mode.reasonCodes.includes('UI_RUNNER_AUTHENTICATION_NOT_CONFIGURED'));
    assert.ok(mode.reasonCodes.includes('UI_RUNNER_AUTHENTICATION_REQUIRED'));
    assert.ok(mode.reasonCodes.includes('UI_RUNNER_TARGET_BUILD_UNVERIFIED'));
    assert.equal(mode.counts.actionsExecuted, 0);
  }
  assert.equal(result.evidence.filter(e => e.kind === 'MODE_RESULT').length, 2);
});
test('Live 401 is explicit access failure, but an observed negative 401 fixture is preserved', async t => {
  const directory = await temporary(t);
  for (const expectedStatus of [200, 401]) {
    const f = fixture(); f.fixture.response.replayStatus = expectedStatus;
    const store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id));
    try {
      const ledger = new Ledger('UI_LIVE', directory), binding = new OriginBinding(f.profile, f.spec.entryUrl);
      const n = await NetworkController.create({ mode: 'UI_LIVE', envelope: f.envelope, store, ledger, profile: f.profile, binding, accounting: { interactions: new Set(), used() {} } }); n.context = f.context;
      const request = { method: () => 'GET', url: () => f.profile.targetBaseUrl + '/api/items?tag=one&tag=two', resourceType: () => 'fetch', postDataBuffer: () => null, allHeaders: async () => ({ accept: '*/*' }), frame: () => ({ parentFrame: () => null }) };
      let fulfilled = false;
      await n.handle({ request: () => request, fetch: async () => ({ status: () => 401, headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from('{"error":"login required"}'), dispose: async () => {} }), fulfill: async () => { fulfilled = true; } });
      await n.finish(); const checks = await readCollection(await ledger.finish(), 'checks', directory);
      assert.equal(fulfilled, true, 'the application receives its actual response');
      assert.equal(checks.filter(c => c.kind === 'APPLICATION_ACCESS' && c.status === 'FAILED').length, expectedStatus === 200 ? 1 : 0);
    } finally { await store.dispose(); }
  }
});
