import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixture.js';
import { ArtifactStore, validateSource } from '../src/source.js';
import { digest, OriginBinding } from '../src/core.js';
import { FixtureMatcher, requestIdentity } from '../src/matcher.js';
import { Ledger, readCollection } from '../src/ledger.js';
import { locatorsFor } from '../src/compare.js';
import { CoverageAccounting } from '../src/accounting.js';
import { parseStrictJson } from '../src/strict-json.js';

test('full immutable source and scope verified before execution; corruption never tolerated', () => {
  const f = fixture(); assert.equal(validateSource(f.compilation, f.response, f.claim.scope).spec.entryUrl, f.spec.entryUrl);
  const corrupt = structuredClone(f.response); corrupt.envelope.journey.entryUrl += '/changed';
  assert.throws(() => validateSource(f.compilation, corrupt, f.claim.scope), { code: 'UI_RUNNER_MANIFEST_HASH_MISMATCH' });
  assert.throws(() => validateSource(f.compilation, f.response, { ...f.claim.scope, organizationId: 'org_foreign' }), { code: 'UI_RUNNER_SCOPE_MISMATCH' });
  const plan = structuredClone(f.compilation); plan.specification.entryUrl += '/changed';
  assert.throws(() => validateSource(plan, f.response, f.claim.scope), { code: 'UI_RUNNER_SPECIFICATION_HASH_MISMATCH' });
});
test('artifact reads check both exact length and sha256, and only declared artifact IDs are accepted', async () => {
  const f = fixture(), store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => id === 'uia_response' ? Buffer.alloc(f.bytes.get(id).length) : f.bytes.get(id));
  try { await assert.rejects(store.bytes('uia_response'), { code: 'UI_RUNNER_ARTIFACT_HASH_MISMATCH' }); await assert.rejects(store.bytes('uia_foreign'), { code: 'UI_RUNNER_ARTIFACT_NOT_DECLARED' }); } finally { await store.dispose(); }
});
test('origin binding never guesses an unmapped service or accepts credentials/cross-origin redirects', () => {
  const f = fixture(); f.profile.targetBaseUrl = 'https://target.example.test'; f.profile.allowedOrigins = ['https://target.example.test']; f.profile.originMap = { 'http://127.0.0.1:3100': 'https://target.example.test' };
  const b = new OriginBinding(f.profile, f.spec.entryUrl);
  assert.equal(b.toTarget('http://127.0.0.1:3100/api?tag=one&tag=two'), 'https://target.example.test/api?tag=one&tag=two');
  assert.equal(b.toSource('https://target.example.test/api'), 'http://127.0.0.1:3100/api');
  assert.throws(() => b.toTarget('https://other.example.test/api'), { code: 'UI_RUNNER_SOURCE_ORIGIN_UNMAPPED' });
  assert.equal(b.permits('https://user:pass@target.example.test/'), false);
});
test('fixture reservation is atomic across bursts and preserves query order, body, headers and context', async () => {
  const f = fixture({ duplicate: true }), store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id));
  try {
    const matcher = await FixtureMatcher.create(f.envelope.bundle.fixtures, store), b = new OriginBinding(f.profile, f.spec.entryUrl);
    const identity = requestIdentity({ url: f.profile.targetBaseUrl + '/api/items?tag=one&tag=two', method: 'GET', body: null, headers: { accept: '*/*' } }, b, f.context);
    assert.equal(matcher.reserve({ ...identity, stepId: 'other_step' }).code, 'UI_RUNNER_REQUEST_UNMATCHED');
    assert.equal(matcher.reserve({ ...identity, headers: { accept: 'application/xml' } }).code, 'UI_RUNNER_REQUEST_PAYLOAD_MISMATCH');
    const reversed = requestIdentity({ url: f.profile.targetBaseUrl + '/api/items?tag=two&tag=one', method: 'GET', body: null, headers: { accept: '*/*' } }, b, f.context);
    assert.equal(matcher.reserve(reversed).code, 'UI_RUNNER_REQUEST_UNMATCHED');
    const results = await Promise.all(Array.from({ length: 20 }, async () => matcher.reserve(identity)));
    assert.deepEqual(results.filter(x => !x.code).map(x => x.fixture.fixtureId), ['uif_sample', 'uif_sample_second']);
    assert.equal(results.filter(x => x.code === 'UI_RUNNER_FIXTURE_EXHAUSTED').length, 18); assert.equal(matcher.consumed, 2);
  } finally { await store.dispose(); }
});
test('missing cached body cannot be used in Replay; Live can match the observation for comparison', async () => {
  const f = fixture({ unavailable: true }), store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id));
  try { const matcher = await FixtureMatcher.create(f.envelope.bundle.fixtures, store); const b = new OriginBinding(f.profile, f.spec.entryUrl); const identity = requestIdentity({ url: f.profile.targetBaseUrl + '/api/items?tag=one&tag=two', method: 'GET', body: null, headers: { accept: '*/*' } }, b, f.context); assert.equal(matcher.reserve(identity).code, 'UI_RUNNER_FIXTURE_UNAVAILABLE'); assert.equal(matcher.reserve(identity, { allowUnavailable: true }).code, null); } finally { await store.dispose(); }
});
test('ledger conserves every record across pages beyond the old 768KiB total cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qagent-ledger-')), uploads = [];
  try {
    const l = new Ledger('UI_LIVE', directory, { pageBytes: 16000, onEvidence: async (r, b) => uploads.push({ ...r, bytes: b.length }) });
    for (let i = 0; i < 6000; i++) await l.check('FIELD', i % 3 === 0 ? 'PENDING' : 'PASSED', { pointer: '/field/' + i }, 'observed', 'current', i % 3 === 0 ? 'UI_RUNNER_LIVE_OBSERVED_DATA_CHANGED' : undefined);
    const result = await l.finish(), rows = await readCollection(result, 'checks', directory);
    assert.equal(rows.length, 6000); assert.equal(l.statuses.PENDING, 2000); assert.equal(l.statuses.PASSED, 4000);
    assert.ok(uploads.reduce((n, r) => n + r.byteLength, 0) > 768 * 1024); assert.ok(uploads.length > 20); assert.equal(result.checks.length, 0); assert.equal(new Set(rows.map(r => r.id)).size, 6000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('locator remapping chooses unique observed IDs and deterministic tree path instead of a first match', () => {
  const nodes = [{ nodeId: 'a', parentId: null, nodeType: 1, name: 'MAIN', attributes: [], text: '' }, ...['b', 'c'].map(nodeId => ({ nodeId, parentId: 'a', nodeType: 1, name: 'INPUT', attributes: [['id', 'duplicate']], text: '' }))];
  const map = locatorsFor(nodes); assert.equal(map.get('b').value, 'main:nth-of-type(1) > input:nth-of-type(1)'); assert.equal(map.get('c').value, 'main:nth-of-type(1) > input:nth-of-type(2)');
});
test('unknown artifact fields remain pending and checksum verification does not count as comparing their contents', async () => {
  const f = fixture({ addUnknown: true }), store = await ArtifactStore.create(f.envelope.bundle.artifacts, async id => f.bytes.get(id)), dir = await mkdtemp(join(tmpdir(), 'qagent-accounting-'));
  try { await store.verifyAll(); const l = new Ledger('UI_REPLAY', dir), a = new CoverageAccounting(f.envelope, store, l); a.used('uia_dom', '/nodes/0'); await a.finish(); const result = await l.finish(), pending = await readCollection(result, 'pending', dir); assert.ok(pending.some(p => p.sourceRef?.pointer === '/futureProperty')); assert.ok(pending.some(p => p.sourceRef?.pointer === '/nodes/0/name')); assert.ok(pending.some(p => p.reasonCode === 'UI_RUNNER_ACTION_NOT_EXECUTED')); } finally { await store.dispose(); await rm(dir, { recursive: true, force: true }); }
});
test('strict evidence JSON rejects duplicate keys, invalid UTF-8, trailing input and unsupported nesting', () => {
  for (const raw of ['{"nodes":[],"nodes":[1]}', '{"fields":[{"value":"one","value":"two"}]}', '{"x":1} trailing', '['.repeat(258) + '0' + ']'.repeat(258)]) assert.throws(() => parseStrictJson(Buffer.from(raw)));
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])));
  assert.equal(parseStrictJson(Buffer.from('{"field":"preserved"}')).field, 'preserved');
});
test('duplicate-key artifact is a whole-artifact pending obligation; raw response bytes remain hash verified', async () => {
  const raw = Buffer.from('{"value":"one","value":"two"}'), { sha256 } = await import('../src/core.js');
  const declaration = { artifactId: 'uia_duplicate', kind: 'ACTION_VALUE_JSON', contentType: 'application/json', completeness: 'COMPLETE', byteLength: raw.length, sha256: sha256(raw) };
  const store = await ArtifactStore.create([declaration], async () => raw), dir = await mkdtemp(join(tmpdir(), 'qagent-invalid-json-'));
  try {
    assert.deepEqual(await store.bytes('uia_duplicate'), raw);
    await assert.rejects(store.json('uia_duplicate'), { code: 'UI_RUNNER_ARTIFACT_JSON_INVALID' });
    const f = fixture(), ledger = new Ledger('UI_REPLAY', dir), accounting = new CoverageAccounting(f.envelope, store, ledger);
    await accounting.finish(); const pending = await readCollection(await ledger.finish(), 'pending', dir);
    assert.ok(pending.some(p => p.reasonCode === 'UI_RUNNER_ARTIFACT_CONTENT_UNREADABLE' && p.sourceRef.artifactId === 'uia_duplicate'));
  } finally { await store.dispose(); await rm(dir, { recursive: true, force: true }); }
});
