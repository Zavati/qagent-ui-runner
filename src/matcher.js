import { digest, sha256, same, insist, RunnerError } from './core.js';

export const CONTEXT = ['documentId', 'navigationId', 'frameId', 'stepId'];
export const contextOf = value => Object.fromEntries(CONTEXT.map(k => [k, value?.[k] ?? null]));
const exactContext = (a, b) => CONTEXT.every(k => (a?.[k] ?? null) === (b?.[k] ?? null));
export function requestKey(row) { return digest({ context: contextOf(row), method: row.request.method, origin: row.request.origin, path: row.request.path, query: row.request.query }); }
export function requestIdentity(request, binding, context) {
  const u = new URL(binding.toSource(request.url));
  return { ...contextOf(context), request: { method: request.method.toUpperCase(), origin: u.origin, path: u.pathname, query: [...u.searchParams.entries()], bodySha256: request.body === null ? null : sha256(request.body) }, headers: request.headers ?? {} };
}
export function fixtureFingerprint(fixture) {
  const r = fixture.request;
  return digest({ service: r.logicalServiceKey, origin: r.origin, method: r.method, path: r.path, query: r.query, bodyHash: r.bodySha256, businessHeadersHash: r.businessHeadersSha256 });
}
export class FixtureMatcher {
  static async create(fixtures, store) {
    const prepared = [];
    for (const f of fixtures) {
      insist(f.match?.policyVersion === 'qagent_ui_observed_fixture_match_v1' && fixtureFingerprint(f) === f.match.requestFingerprint, 'UI_RUNNER_FIXTURE_FINGERPRINT_INVALID');
      insist(exactContext(f, f.match) && f.match.causalProof === false && f.match.orderBasis === 'OBSERVED_REQUEST_DISPATCH', 'UI_RUNNER_FIXTURE_CONTEXT_INVALID');
      insist(f.consumption?.liveFallback === false && f.consumption?.reuseAfterExhaustion === false && f.consumption?.maximum === 1 && [0, 1].includes(f.consumption?.minimum), 'UI_RUNNER_FIXTURE_CONSUMPTION_UNSUPPORTED');
      const headers = f.request.businessHeadersRef ? await store.json(f.request.businessHeadersRef, 'HEADERS_JSON') : [];
      insist(Array.isArray(headers) && headers.every(h => Array.isArray(h) && h.length === 2 && h.every(x => typeof x === 'string')), 'UI_RUNNER_HEADERS_INVALID');
      insist(new Set(headers.map(([name]) => name.toLowerCase())).size === headers.length, 'UI_RUNNER_REQUEST_HEADERS_DUPLICATE_UNSUPPORTED');
      if (f.request.businessHeadersRef) insist(store.declaration(f.request.businessHeadersRef).sha256 === f.request.businessHeadersSha256, 'UI_RUNNER_FIXTURE_HEADERS_HASH_MISMATCH');
      if (f.request.bodyRef) insist(store.declaration(f.request.bodyRef).sha256 === f.request.bodySha256, 'UI_RUNNER_FIXTURE_BODY_HASH_MISMATCH');
      if (f.response.bodyRef) insist(store.declaration(f.response.bodyRef).sha256 === f.response.bodySha256, 'UI_RUNNER_FIXTURE_BODY_HASH_MISMATCH');
      if (f.response.headersRef) insist(store.declaration(f.response.headersRef).sha256 === f.response.headersSha256, 'UI_RUNNER_FIXTURE_HEADERS_HASH_MISMATCH');
      prepared.push({ fixture: f, headers, consumed: 0 });
    }
    return new FixtureMatcher(prepared);
  }
  constructor(entries) {
    this.entries = entries; this.groups = new Map();
    for (const row of entries) { const key = requestKey(row.fixture), group = this.groups.get(key) ?? []; group.push(row); this.groups.set(key, group); }
    for (const group of this.groups.values()) group.sort((a, b) => a.fixture.match.occurrenceIndex - b.fixture.match.occurrenceIndex || a.fixture.requestSequence - b.fixture.requestSequence);
  }
  /** All metadata ready before this synchronous reservation: simultaneous requests cannot reuse a fixture. */
  reserve(identity, { allowUnavailable = false } = {}) {
    const group = this.groups.get(requestKey(identity)) ?? [];
    if (!group.length) return { code: 'UI_RUNNER_REQUEST_UNMATCHED', fixture: null };
    const matches = group.filter(({ fixture: f, headers }) => {
      if (f.request.bodySha256 !== identity.request.bodySha256 || !same(f.request.query, identity.request.query)) return false;
      return headers.every(([name, value]) => String(identity.headers[name.toLowerCase()] ?? '') === value);
    });
    if (!matches.length) return { code: 'UI_RUNNER_REQUEST_PAYLOAD_MISMATCH', fixture: null };
    const next = matches.find(r => r.consumed < r.fixture.consumption.maximum);
    if (!next) return { code: 'UI_RUNNER_FIXTURE_EXHAUSTED', fixture: null };
    // Same dispatch index and different fixture identities cannot be disambiguated by guessing.
    if (matches.filter(r => !r.consumed && r.fixture.match.occurrenceIndex === next.fixture.match.occurrenceIndex).length !== 1) return { code: 'UI_RUNNER_FIXTURE_AMBIGUOUS', fixture: null };
    if (!allowUnavailable && next.fixture.availability !== 'READY') return { code: 'UI_RUNNER_FIXTURE_UNAVAILABLE', fixture: next.fixture };
    next.consumed++; return { code: null, fixture: next.fixture };
  }
  get consumed() { return this.entries.reduce((n, r) => n + r.consumed, 0); }
  unresolved() { return this.entries.filter(r => r.consumed < r.fixture.consumption.minimum); }
}

export async function responseForFixture(f, store) {
  const r = f.response;
  insist(f.availability === 'READY' && ['COMPLETE', 'EMPTY'].includes(r.bodyState), 'UI_RUNNER_FIXTURE_UNAVAILABLE');
  insist(Number.isInteger(r.replayStatus) && r.replayStatus >= 200 && r.replayStatus <= 599 && r.replayStatus !== 304, 'UI_RUNNER_FIXTURE_STATUS_UNSUPPORTED');
  const body = r.bodyRef ? await store.bytes(r.bodyRef) : Buffer.alloc(0);
  insist(r.bodyState !== 'COMPLETE' || r.bodyRef, 'UI_RUNNER_FIXTURE_BODY_MISSING');
  const pairs = r.headersRef ? await store.json(r.headersRef, 'HEADERS_JSON') : [];
  insist(Array.isArray(pairs), 'UI_RUNNER_HEADERS_INVALID');
  const headers = {};
  // Chromium receives decoded artifact bytes. Compression/hop framing must be recomputed.
  const transport = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']);
  for (const [key, value] of pairs) {
    const name = key.toLowerCase();
    if (transport.has(name)) continue;
    // route.fulfill uses a dictionary: do not silently fold multi-value Set-Cookie semantics.
    if (Object.hasOwn(headers, name)) throw new RunnerError('UI_RUNNER_RESPONSE_HEADERS_DUPLICATE_UNSUPPORTED');
    headers[name] = value;
  }
  if (r.contentType && !headers['content-type']) headers['content-type'] = r.contentType;
  return { status: r.replayStatus, headers, body };
}
