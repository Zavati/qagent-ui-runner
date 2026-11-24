import { RunnerError, insist, sha256, digest, codeOf, checkAbort, sleep } from './core.js';
import { FixtureMatcher, contextOf, requestIdentity, responseForFixture } from './matcher.js';

const runtimeType = value => ({ xhr: 'XHR', fetch: 'Fetch', document: 'Document', script: 'Script', stylesheet: 'Stylesheet', image: 'Image', font: 'Font' }[value] ?? value);
export class NetworkController {
  static async create(options) { const matcher = await FixtureMatcher.create(options.envelope.bundle.fixtures, options.store); return new NetworkController({ ...options, matcher }); }
  constructor(options) { Object.assign(this, options); this.records = new Map(); this.persisted = new Set(); this.inflight = new Set(); this.serial = 0; this.context = null; this.errors = []; this.quiesceAt = Date.now(); this.flushErrors = []; }
  async install(browserContext) {
    browserContext.on('request', request => {
      const context = contextOf(this.context);
      this.records.set(request, { id: 'uirq_' + String(++this.serial).padStart(9, '0'), context, method: request.method(), url: request.url(), resourceType: runtimeType(request.resourceType()), startedAt: new Date().toISOString(), status: null, fixtureId: null, replayed: false });
      this.quiesceAt = Date.now();
    });
    await browserContext.route('**/*', route => {
      const p = this.handle(route).catch(async e => {
        const record = this.records.get(route.request());
        if (record) record.reasonCode = codeOf(e);
        this.errors.push(codeOf(e));
        await this.ledger.pending(record ? this.sourceFor(record) : null, codeOf(e, 'UI_RUNNER_NETWORK_TRANSPORT_ERROR'));
        try { await route.abort('failed'); } catch {}
      }).finally(async () => {
        try { await this.persistRecord(this.records.get(route.request())); }
        catch (error) { this.flushErrors.push(error); }
        finally { this.inflight.delete(p); this.quiesceAt = Date.now(); }
      });
      this.inflight.add(p); return p;
    });
    // No covert WebSocket business calls outside the HTTP fixture matcher.
    await browserContext.routeWebSocket('**/*', async socket => {
      await this.ledger.pending({ url: socket.url() }, 'UI_RUNNER_WEBSOCKET_UNSUPPORTED');
      socket.close({ code: 1008, reason: 'Unsupported observed transport' });
    });
    browserContext.on('page', page => {
      page.on('dialog', async dialog => { await this.ledger.pending(null, 'UI_RUNNER_DIALOG_UNSUPPORTED', { type: dialog.type() }); await dialog.dismiss().catch(() => {}); });
      page.on('download', async download => { await download.cancel(); await this.ledger.pending(null, 'UI_RUNNER_DOWNLOAD_UNSUPPORTED'); });
    });
  }
  sourceFor(record) { return { requestId: record.id, context: record.context }; }
  async persistRecord(record) {
    if (!record || this.persisted.has(record.id)) return;
    if (!record.completedAt && !record.reasonCode) { record.reasonCode = 'UI_RUNNER_REQUEST_NOT_COMPLETED'; await this.ledger.pending(this.sourceFor(record), record.reasonCode); }
    await this.ledger.append('network', record); this.persisted.add(record.id);
  }
  async handle(route) {
    checkAbort(this.signal); const request = route.request();
    let record = this.records.get(request);
    if (!record) { record = { id: 'uirq_' + String(++this.serial).padStart(9, '0'), context: contextOf(this.context), method: request.method(), url: request.url(), resourceType: runtimeType(request.resourceType()), startedAt: new Date().toISOString(), status: null, fixtureId: null, replayed: false }; this.records.set(request, record); }
    const fail = async code => { record.reasonCode = code; this.errors.push(code); await this.ledger.check('NETWORK_REQUEST', 'FAILED', this.sourceFor(record), null, { method: record.method, url: record.url }, code); await route.abort('blockedbyclient'); };
    if (!this.binding.permits(request.url())) { await fail('UI_RUNNER_ORIGIN_NOT_ALLOWED'); return; }
    let frame;
    try { frame = request.frame(); } catch { await fail('UI_RUNNER_WORKER_REQUEST_CONTEXT_UNAVAILABLE'); return; }
    if (frame.parentFrame()) { await fail('UI_RUNNER_SUBFRAME_UNSUPPORTED'); return; }
    const body = request.postDataBuffer();
    record.requestBodySha256 = body === null ? null : sha256(body);
    const headers = await request.allHeaders();
    const identity = requestIdentity({ url: request.url(), method: request.method(), body, headers }, this.binding, record.context);
    record.sourceUrl = this.binding.toSource(request.url());
    const isFetch = ['XHR', 'Fetch'].includes(record.resourceType);
    const sourceUrl = new URL(record.sourceUrl);
    const observed = this.envelope.pageIndex.interactions.filter(n => n.request.method === record.method && n.request.origin === sourceUrl.origin && n.request.path === sourceUrl.pathname);
    const explicitBusiness = observed.some(n => n.classification === 'BUSINESS_API');
    const knownNonBusiness = observed.some(n => n.classification !== 'BUSINESS_API' && n.resourceType === record.resourceType && digest(n.request.query) === digest(identity.request.query));
    const business = explicitBusiness || (isFetch && !knownNonBusiness);
    record.business = business;
    if (this.mode === 'UI_REPLAY' && !business && !['GET', 'HEAD'].includes(record.method)) { await fail('UI_RUNNER_REPLAY_UNMATCHED_WRITE_BLOCKED'); return; }
    if (this.mode === 'UI_REPLAY' && !business && !knownNonBusiness && !['Document', 'Script', 'Stylesheet', 'Image', 'Font', 'media', 'manifest'].includes(record.resourceType)) { await fail('UI_RUNNER_REPLAY_TRANSPORT_UNSUPPORTED'); return; }
    let fixture = null;
    if (business) {
      const match = this.matcher.reserve(identity, { allowUnavailable: this.mode === 'UI_LIVE' }); fixture = match.fixture;
      if (match.code && this.mode === 'UI_REPLAY') { await fail(match.code); return; }
      if (match.code) { record.reasonCode = match.code; await this.ledger.pending(this.sourceFor(record), 'UI_RUNNER_LIVE_REQUEST_NOT_IN_BASELINE', { matchingReason: match.code }); }
      if (fixture) {
        record.fixtureId = fixture.fixtureId; record.eventId = fixture.eventId; this.accounting.interactions.add(fixture.eventId);
        await this.ledger.check('REQUEST_MATCHES', 'PASSED', { pointer: '/bundle/fixtures/' + this.envelope.bundle.fixtures.indexOf(fixture), manifestHash: this.envelope.manifestHash }, fixture.match.requestFingerprint, fixture.match.requestFingerprint);
        if (fixture.request.bodyRef) this.accounting.used(fixture.request.bodyRef, '', true);
        if (fixture.request.businessHeadersRef) this.accounting.used(fixture.request.businessHeadersRef, '', true);
      }
    }
    if (this.mode === 'UI_REPLAY' && business) {
      insist(fixture, 'UI_RUNNER_FIXTURE_UNAVAILABLE');
      const fulfilled = await responseForFixture(fixture, this.store);
      record.status = fulfilled.status; record.responseBodySha256 = sha256(fulfilled.body); record.replayed = true;
      await route.fulfill(fulfilled);
      if (fixture.response.bodyRef) this.accounting.used(fixture.response.bodyRef, '', true);
      // Stripped transport framing is documented by responseForFixture; response headers are not silently compared.
      if (fixture.response.headersRef) await this.ledger.pending(this.store.ref(fixture.response.headersRef), 'UI_RUNNER_RESPONSE_HEADER_COMPARISON_PENDING');
      record.completedAt = new Date().toISOString(); return;
    }
    // A single real network request, no HTTP retries and no automatic redirect outside the binding.
    // The application still emits every request; Live never proactively sends recorded requests.
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: this.profile.stepTimeoutMs });
    try {
      record.status = response.status();
      if (this.mode === 'UI_LIVE' && [401, 403].includes(record.status) && fixture?.response.replayStatus !== record.status) {
        await this.ledger.check('APPLICATION_ACCESS', 'FAILED', this.sourceFor(record), { access: 'AVAILABLE' }, { status: record.status }, record.status === 401 ? 'UI_RUNNER_AUTHENTICATION_REQUIRED' : 'UI_RUNNER_ACCESS_FORBIDDEN');
      }
      const responseHeaders = response.headers(), location = responseHeaders.location;
      if (record.status >= 300 && record.status < 400 && location && !this.binding.permits(new URL(location, request.url()).href)) { await fail('UI_RUNNER_REDIRECT_ORIGIN_NOT_ALLOWED'); return; }
      if (business && fixture) {
        const ref = { pointer: '/bundle/fixtures/' + this.envelope.bundle.fixtures.indexOf(fixture) + '/response', manifestHash: this.envelope.manifestHash };
        if (fixture.response.replayStatus === null) await this.ledger.pending(ref, 'UI_RUNNER_OBSERVED_RESPONSE_STATUS_UNAVAILABLE');
        else {
          const equal = fixture.response.replayStatus === response.status();
          await this.ledger.check('HTTP_STATUS_OBSERVED_DIFF', equal ? 'PASSED' : 'PENDING', ref, fixture.response.replayStatus, response.status(), equal ? undefined : 'UI_RUNNER_LIVE_RESPONSE_STATUS_CHANGED');
        }
        if (['COMPLETE', 'EMPTY'].includes(fixture.response.bodyState)) {
          const bytes = await response.body(); record.responseBodySha256 = sha256(bytes); record.responseBytes = bytes.length;
          const expected = fixture.response.bodyRef ? fixture.response.bodySha256 : sha256(Buffer.alloc(0));
          const equal = expected === record.responseBodySha256;
          await this.ledger.check('HTTP_BODY_OBSERVED_DIFF', equal ? 'PASSED' : 'PENDING', ref, { sha256: expected }, { sha256: record.responseBodySha256, byteLength: bytes.length }, equal ? undefined : 'UI_RUNNER_LIVE_RESPONSE_BODY_CHANGED');
          if (fixture.response.bodyRef) this.accounting.used(fixture.response.bodyRef, '', true);
          if (!equal && bytes.length <= 8 * 1024 * 1024) await this.ledger.attachment('RESPONSE_BODY', bytes, responseHeaders['content-type'] ?? 'application/octet-stream', '.bin');
          else if (!equal) await this.ledger.pending(ref, 'UI_RUNNER_LARGE_ACTUAL_BODY_HASH_ONLY', { byteLength: bytes.length, sha256: record.responseBodySha256 });
        } else await this.ledger.pending(ref, 'UI_RUNNER_OBSERVED_RESPONSE_BODY_UNAVAILABLE');
      }
      await route.fulfill({ response }); record.completedAt = new Date().toISOString();
    } finally { await response.dispose(); }
  }
  async settle() {
    const deadline = Date.now() + this.profile.stepTimeoutMs;
    while (this.inflight.size || Date.now() - this.quiesceAt < 150) {
      checkAbort(this.signal);
      if (Date.now() >= deadline) { await this.ledger.pending(null, 'UI_RUNNER_NETWORK_NOT_QUIESCENT'); return false; }
      await sleep(30, this.signal);
    }
    return true;
  }
  async finish() {
    await Promise.allSettled(this.inflight);
    for (const record of this.records.values()) await this.persistRecord(record);
    if (this.flushErrors.length) throw this.flushErrors[0];
    for (const row of this.matcher.entries) {
      const f = row.fixture, ref = { pointer: '/bundle/fixtures/' + this.envelope.bundle.fixtures.indexOf(f) + '/consumption', manifestHash: this.envelope.manifestHash };
      const okay = row.consumed >= f.consumption.minimum && row.consumed <= f.consumption.maximum;
      await this.ledger.check('FIXTURE_CONSUMPTION_MATCHES', okay ? 'PASSED' : 'PENDING', ref, f.consumption, row.consumed, okay ? undefined : 'UI_RUNNER_FIXTURE_NOT_CONSUMED');
    }
  }
}
