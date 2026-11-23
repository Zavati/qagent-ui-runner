import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayClient } from '../src/client.js';
import { Worker } from '../src/worker.js';
import { technicalPair, launchBrowserSafely, performAction } from '../src/engine.js';
import { Ledger } from '../src/ledger.js';
import { sha256, RunnerError, OriginBinding } from '../src/core.js';
import { fixture } from './fixture.js';
import { ArtifactStore } from '../src/source.js';
import { pairExitCode, batchExitCode, pairJUnit } from '../src/reports.js';

const client = fetchImpl => new GatewayClient({ apiUrl: 'https://gateway.example.test', projectId: 'prj_test', environmentId: 'env_test', token: 'scoped-machine-token-only-0123456789', fetchImpl });
const okay = data => new Response(JSON.stringify({ status: 'ok', data }), { headers: { 'Content-Type': 'application/json' } });
test('claim POST is never retried after uncertain transport; idempotent evidence retries retain hash and token', async () => {
  let calls = 0; const c = client(async () => { calls++; throw new TypeError('transport gone'); });
  await assert.rejects(c.claim('uieb_test', 'uiworker_test'), { code: 'UI_RUNNER_TRANSPORT_FAILED' }); assert.equal(calls, 1);
  const requests = [], bytes = Buffer.from('evidence'), ref = { evidenceId: 'uire_test', sha256: sha256(bytes), byteLength: bytes.length, contentType: 'application/x-ndjson' };
  const retry = client(async (url, init) => { requests.push({ url, init }); return requests.length === 1 ? new Response('temporary', { status: 503 }) : okay(ref); });
  await retry.evidence({ batchId: 'uieb_test', itemId: 'uiebi_test', claimToken: 'claim-scoped-token' }, ref, bytes);
  assert.equal(requests.length, 2); assert.equal(requests[0].init.redirect, 'error'); assert.equal(requests[1].init.headers['X-QAgent-SHA256'], ref.sha256); assert.equal(requests[1].init.headers['X-QAgent-Claim-Token'], 'claim-scoped-token'); assert.equal(requests[1].init.headers.Authorization, 'Bearer scoped-machine-token-only-0123456789');
});
test('artifact transport validates bytes ceiling; gateway errors retain only structured code', async () => {
  const c = client(async () => new Response(Buffer.alloc(20))); await assert.rejects(c.artifact({ batchId: 'b', itemId: 'i', claimToken: 'token' }, 'uia_test', { maxBytes: 10 }), { code: 'UI_RUNNER_RESPONSE_SIZE_LIMIT' });
  const forbidden = client(async () => new Response(JSON.stringify({ status: 'error', code: 'UI_EXECUTION_SCOPE_FORBIDDEN', message: 'do not log secrets here' }), { status: 403 }));
  const error = await forbidden.batch('uieb_test').catch(e => e); assert.equal(error.code, 'UI_EXECUTION_SCOPE_FORBIDDEN'); assert.equal(error.message, error.code);
});
test('late browser resolution after abort is closed, preventing a leaked browser process', async () => {
  const ctrl = new AbortController(); let closed = false, resolve;
  const promise = launchBrowserSafely(() => new Promise(r => { resolve = r; }), {}, ctrl.signal);
  await Promise.resolve(); ctrl.abort(new RunnerError('UI_RUNNER_CANCELLED')); await assert.rejects(promise, { code: 'UI_RUNNER_CANCELLED' });
  resolve({ close: async () => { closed = true; } }); await new Promise(r => setImmediate(r)); assert.equal(closed, true);
});
test('repeated attachment content is deduplicated and large traces are reconstructable parts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-binary-')), uploads = [];
  try {
    const l = new Ledger('UI_LIVE', dir, { onEvidence: async (r, b) => uploads.push({ ref: r, bytes: b }) });
    await l.attachment('BODY', Buffer.from('same'), 'application/json', '.json'); await l.attachment('BODY', Buffer.from('same'), 'application/json', '.json');
    assert.equal(l.evidence.length, 1);
    const data = Buffer.alloc(17 * 1024 * 1024, 42); const ref = await l.attachment('TRACE', data, 'application/zip', '.zip');
    const manifest = JSON.parse(uploads.find(x => x.ref.evidenceId === ref.evidenceId).bytes);
    const reconstructed = Buffer.concat(manifest.parts.map(p => uploads.find(x => x.ref.evidenceId === p.evidenceId).bytes));
    assert.equal(sha256(reconstructed), manifest.sha256); assert.equal(reconstructed.length, data.length); assert.ok(uploads.every(x => x.bytes.length <= 8 * 1024 * 1024));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('technical fallback uses a distinct evidence namespace; heartbeat is stopped even when upload fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qagent-worker-')); let heartbeats = 0;
  const f = fixture(), fakeClient = { source: async () => { await new Promise(r => setTimeout(r, 30)); throw new RunnerError('UI_RUNNER_TRANSPORT_TIMEOUT'); }, evidence: async () => { throw new RunnerError('UI_RUNNER_UPLOAD_FAILED'); }, heartbeat: async () => { heartbeats++; return { cancelRequested: false, leaseExpiresAt: Date.now() + 90000 }; } };
  try {
    const worker = new Worker({ client: fakeClient, directory: dir, heartbeatMs: 5, log() {} });
    await assert.rejects(worker.executeClaim(f.claim), { code: 'UI_RUNNER_UPLOAD_FAILED' }); const stopped = heartbeats; await new Promise(r => setTimeout(r, 30)); assert.equal(heartbeats, stopped);
    const one = await technicalPair(f.claim, 'UI_RUNNER_ERROR_ONE', dir), two = await technicalPair(f.claim, 'UI_RUNNER_ERROR_TWO', dir); assert.notEqual(one.evidence[0].evidenceId, two.evidence[0].evidenceId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('all six deterministic action operators use the recorded values; ambiguity fails before click', async () => {
  const f = fixture(), store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id)), calls = [];
  const l = { waitFor: async () => {}, count: async () => 1, click: async value => calls.push(['CLICK', value]), fill: async value => calls.push(['FILL', value]), selectOption: async value => calls.push(['SELECT', value]), setChecked: async value => calls.push(['CHECK', value]), evaluate: async (_, value) => calls.push(['ELEMENT_SCROLL', value]) };
  const page = { getByTestId: () => l, locator: () => l, goto: async value => calls.push(['NAVIGATE', value]), evaluate: async (_, value) => calls.push(['SCROLL', value]) };
  try {
    const binding = new OriginBinding(f.profile, f.spec.entryUrl), accounting = { used() {} };
    for (const type of ['NAVIGATE', 'CLICK', 'FILL', 'SELECT', 'CHECK', 'SCROLL']) {
      const a = { ...f.fill, type, destination: f.spec.entryUrl, checked: true, position: { scrollX: 0, scrollY: 15 }, scrollTarget: null };
      await performAction(page, a, store, f.profile, binding, accounting);
    }
    assert.deepEqual(calls.map(c => c[0]), ['NAVIGATE', 'CLICK', 'FILL', 'SELECT', 'CHECK', 'SCROLL']); assert.equal(calls[2][1], 'observed input'); assert.deepEqual(calls[3][1], { value: 'observed input' });
    l.count = async () => 2; await assert.rejects(performAction(page, { ...f.fill, type: 'CLICK' }, store, f.profile, binding, accounting), { code: 'UI_RUNNER_LOCATOR_AMBIGUOUS' });
  } finally { await store.dispose(); }
});
test('CI exit and JUnit cannot present incomplete evidence as passing', async () => {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'qagent-reports-'));
  try { const pair = await technicalPair(f.claim, 'UI_RUNNER_TEST_INCOMPLETE', dir); assert.equal(pairExitCode(pair), 2); assert.match(pairJUnit(pair), /<error /); pair.modes[0].status = 'FAILED'; pair.modes[0].counts.checksFailed = 1; assert.equal(pairExitCode(pair), 1); pair.modes[1].status = 'CANCELLED'; assert.equal(pairExitCode(pair), 130); } finally { await rm(dir, { recursive: true, force: true }); }
});
test('defensive CI gates reject zero-item batches and repeated mode names', () => {
  const mode = { mode: 'UI_REPLAY', status: 'PASSED', executionPerformed: true, counts: { checksPassed: 1, checksFailed: 0, checksPending: 0, actionsExecuted: 1, actionsPlanned: 1, checkpointsReached: 1, checkpointsPlanned: 1 }, reasonCodes: [] };
  assert.equal(pairExitCode({ modes: [mode, mode] }), 2); assert.equal(batchExitCode({ status: 'COMPLETED', gate: 'PASSED', items: [] }), 2);
  const bad = { ...mode, counts: { ...mode.counts, checksPassed: 0 } }; assert.match(pairJUnit({ modes: [bad, { ...bad, mode: 'UI_LIVE' }] }), /errors="2"/);
  assert.equal(pairExitCode({ modes: [{ ...mode, counts: {} }, { ...mode, mode: 'UI_LIVE', counts: {} }] }), 2);
});
