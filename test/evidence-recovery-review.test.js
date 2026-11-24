import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/source.js';
import { UiRunner } from '../src/engine.js';
import { Worker } from '../src/worker.js';
import { Ledger, readCollection } from '../src/ledger.js';
import { NetworkController } from '../src/network.js';
import { RunnerError, sha256, OriginBinding } from '../src/core.js';
import { fixture } from './fixture.js';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qagent-evidence-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
function failCleanup(t) {
  const original = ArtifactStore.prototype.dispose;
  t.mock.method(ArtifactStore.prototype, 'dispose', async function () {
    await original.call(this);
    throw new Error('synthetic cleanup failure');
  });
}

test('cleanup failure preserves both real navigation attempts and their results through Worker publication', async t => {
  const directory = await temporary(t), f = fixture(), visited = [], published = [];
  f.claim.profile.preparationMode = 'UNAUTHENTICATED'; failCleanup(t);
  const browserLauncher = async () => ({
    async newContext() {
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {}, async route() {}, async unroute() {}, async routeWebSocket() {}, async close() {},
        tracing: { async start() {}, async stop({ path }) { await writeFile(path, 'synthetic trace'); } },
        async newPage() { return { async close() {}, async goto(url) { visited.push(url); throw new RunnerError('UI_RUNNER_AUTHENTICATION_REQUIRED'); }, async screenshot() { return Buffer.from('synthetic screenshot'); } }; },
      };
    }, async close() {},
  });
  let result;
  const client = {
    async source() { return f.response; }, async artifact(_claim, id) { return f.bytes.get(id); },
    async heartbeat() { return { leaseExpiresAt: Date.now() + 90000, cancelRequested: false }; },
    async evidence(_claim, ref) { published.push(ref); },
    async result(_claim, pair) { result = pair; return pair; },
  };
  await new Worker({ client, directory, log() {}, engineFactory: options => new UiRunner({ ...options, browserLauncher }) }).executeClaim(f.claim);
  assert.equal(visited.length, 2, 'Replay and Live each navigate once, without retrying a browser');
  assert.equal(result.executionPerformed, true);
  for (const mode of result.modes) {
    assert.equal(mode.executionPerformed, true); assert.equal(mode.status, 'FAILED');
    assert.ok(mode.reasonCodes.includes('UI_RUNNER_AUTHENTICATION_REQUIRED'));
    assert.ok(mode.counts.checksFailed > 0);
    const checks = await readCollection(mode, 'checks', join(directory, f.claim.batchId, f.claim.itemId));
    assert.equal(checks.filter(c => c.status === 'FAILED').length, mode.counts.checksFailed);
  }
  assert.ok(result.modes[1].reasonCodes.includes('UI_RUNNER_ARTIFACT_CLEANUP_FAILED'));
  assert.ok(result.evidence.every(ref => published.some(p => p.evidenceId === ref.evidenceId)));
  assert.equal(result.evidence.filter(ref => ref.kind === 'MODE_RESULT').length, 2);
});

test('cleanup failure cannot mask a source error before any execution', async t => {
  const directory = await temporary(t), f = fixture(); failCleanup(t); let launched = 0;
  const runner = new UiRunner({ outputDirectory: directory, browserLauncher: async () => { launched++; throw new Error('must not launch'); } });
  await assert.rejects(runner.runPair({ claim: f.claim, sourceResponse: f.response, readArtifact: async () => { throw new RunnerError('UI_RUNNER_SOURCE_UNAVAILABLE'); } }), { code: 'UI_RUNNER_SOURCE_UNAVAILABLE' });
  assert.equal(launched, 0);
});

test('cleanup after otherwise successful modes keeps measured counters and exposes an incomplete result', async t => {
  const directory = await temporary(t), f = fixture(); failCleanup(t);
  const runner = new UiRunner({ outputDirectory: directory });
  let modeCalls = 0;
  runner.runMode = async ({ mode }) => {
    modeCalls++;
    return { mode: { mode, status: 'PASSED', executionPerformed: true, reasonCodes: [], counts: { actionsExecuted: 2, checkpointsReached: 1, checksPassed: 3, checksFailed: 0, checksPending: 0 } }, evidence: [] };
  };
  const result = await runner.runPair({ claim: f.claim, sourceResponse: f.response, readArtifact: async id => f.bytes.get(id) });
  assert.equal(modeCalls, 2); assert.equal(result.executionPerformed, true);
  assert.equal(result.modes[0].status, 'PASSED'); assert.equal(result.modes[1].status, 'INCOMPLETE');
  assert.deepEqual(result.modes[1].counts, { actionsExecuted: 2, checkpointsReached: 1, checksPassed: 3, checksFailed: 0, checksPending: 0 });
  assert.deepEqual(result.modes[1].reasonCodes, ['UI_RUNNER_ARTIFACT_CLEANUP_FAILED']);
});

test('response evidence canonicalizes media types before immutable refs and upload callbacks', async t => {
  const directory = await temporary(t), published = [];
  const ledger = new Ledger('UI_LIVE', directory, { onEvidence: (ref, bytes, path) => published.push({ ref, bytes, path }), flushIntervalMs: 0 });
  const body = Buffer.from('{"changed":true}');
  const ref = await ledger.attachment('RESPONSE_BODY', body, ' Application/JSON; charset=utf-8 ', '.bin');
  assert.equal(ref.contentType, 'application/json');
  assert.equal(published[0].ref.contentType, 'application/json');
  assert.equal(ref.sha256, sha256(body)); assert.deepEqual(await readFile(published[0].path), body);
  await assert.rejects(ledger.attachment('RESPONSE_BODY', body, 'invalid media type', '.bin'), { code: 'UI_RUNNER_EVIDENCE_CONTENT_TYPE_INVALID' });
  await ledger.finish();
});

test('a changed Live JSON response with charset produces publishable evidence without changing the real response', async t => {
  const directory = await temporary(t), f = fixture(), body = Buffer.from('{"title":"Current item"}');
  const store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id)), published = [];
  const ledger = new Ledger('UI_LIVE', directory, { onEvidence: (ref, bytes, path) => published.push({ ref, bytes, path }), flushIntervalMs: 0 });
  try {
    const network = await NetworkController.create({ mode: 'UI_LIVE', envelope: f.envelope, store, ledger, profile: f.profile,
      binding: new OriginBinding(f.profile, f.spec.entryUrl), accounting: { interactions: new Set(), used() {} } });
    network.context = f.context;
    const request = { method: () => 'GET', url: () => f.profile.targetBaseUrl + '/api/items?tag=one&tag=two', resourceType: () => 'fetch', postDataBuffer: () => null,
      allHeaders: async () => ({ accept: '*/*' }), frame: () => ({ parentFrame: () => null }) };
    const response = { status: () => 200, headers: () => ({ 'content-type': 'application/json; charset=utf-8' }), body: async () => body, dispose: async () => {} };
    let fulfilled;
    await network.handle({ request: () => request, fetch: async () => response, fulfill: async value => { fulfilled = value.response; } });
    await network.finish(); const report = await ledger.finish();
    assert.equal(fulfilled, response, 'Live forwards the real response exactly once');
    const attachment = published.find(p => p.ref.kind === 'RESPONSE_BODY');
    assert.ok(attachment); assert.equal(attachment.ref.contentType, 'application/json'); assert.deepEqual(attachment.bytes, body);
    const diff = (await readCollection(report, 'checks', directory)).find(check => check.kind === 'HTTP_BODY_OBSERVED_DIFF');
    assert.equal(diff.status, 'PENDING'); assert.equal(diff.reasonCode, 'UI_RUNNER_LIVE_RESPONSE_BODY_CHANGED');
  } finally { await store.dispose(); }
});

test('large attachments retain the canonical original media type in their binary-parts manifest', async t => {
  const directory = await temporary(t), ledger = new Ledger('UI_LIVE', directory);
  const ref = await ledger.attachment('RESPONSE_BODY', Buffer.alloc(8 * 1024 * 1024 + 1, 7), ' Application/JSON; charset=utf-8 ', '.bin');
  const manifest = JSON.parse(await readFile(join(directory, ref.evidenceId + '.json'), 'utf8'));
  assert.equal(manifest.contentType, 'application/json'); assert.equal(manifest.parts.length, 2);
  assert.ok(manifest.parts.every(part => part.contentType === 'application/octet-stream'));
  assert.equal(ref.contentType, 'application/json'); await ledger.finish();
});
