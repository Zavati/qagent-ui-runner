import { configuredScope, validateDispatch, scopeKey, reply, rejected, readBytes, ensure, safeCode, HostingError } from './protocol.js';

const POLL_MS = 30000, INACTIVITY_MS = 10 * 60 * 1000, STARTUP_MS = 120000, STOP_MS = 30000, INFRASTRUCTURE_LOSS_MS = 5 * 60 * 1000;
const terminal = state => ['COMPLETED', 'CANCELLED'].includes(state?.phase);

// D1 remains the execution authority. This controller stores only the durable intent
// to supply compute; a restarted process must acquire every item from the Gateway.
export class HostedController {
  constructor(ctx, env, { now = Date.now, fetchImpl = fetch, randomToken = () => crypto.randomUUID() + '_' + crypto.randomUUID() } = {}) {
    Object.assign(this, { ctx, env, now, fetchImpl, randomToken });
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('job') ?? null;
      if (ctx.container?.running) await ctx.container.setInactivityTimeout(INACTIVITY_MS);
    });
  }
  async save() { await this.ctx.storage.put('job', this.state); }
  async schedule(delay = POLL_MS) { await this.ctx.storage.setAlarm(this.now() + delay); }
  view() { const s = this.state; return s ? { accepted: true, batchId: s.request.batchId, phase: s.phase, attempts: s.attempts, lastError: s.lastError ?? null, updatedAt: s.updatedAt, runtimeRunning: !!this.ctx.container?.running, ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }) } : { accepted: false, phase: 'NOT_DISPATCHED' }; }
  async fetch(request) {
    try {
      await this.ready;
      const action = new URL(request.url).pathname;
      if (request.method !== 'POST' || !['/dispatch', '/status'].includes(action)) return new Response('Not found', { status: 404 });
      const body = validateDispatch(await request.json()); configuredScope(this.env, body.scope);
      if (this.state) ensure(this.state.request.batchId === body.batchId && scopeKey(this.state.request.scope) === scopeKey(body.scope), 'UI_RUNNER_DISPATCH_CONFLICT', 409);
      if (action === '/status') return reply(this.view());
      if (!this.state) { this.state = { request: body, phase: 'ACCEPTED', attempts: 0, updatedAt: this.now(), runtimeToken: this.randomToken() }; await this.save(); }
      if (!terminal(this.state)) await this.schedule(1);
      // Storage and alarm are durable before the 202; neither browser launch nor
      // the batch duration is bound to the inbound Gateway request.
      return reply(this.view(), 202);
    } catch (error) { return rejected(error); }
  }
  async gatewayBatch(row) {
    const { projectId, environmentId } = this.state.request.scope;
    const response = await this.fetchImpl(`${row.apiUrl}/v1/automation/projects/${projectId}/environments/${environmentId}/ui-executions/batches/${this.state.request.batchId}`, { headers: { Authorization: 'Bearer ' + row.token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    ensure(response.ok, 'UI_RUNNER_GATEWAY_RECONCILIATION_FAILED');
    const bytes = await readBytes(response, 8 * 1024 * 1024);
    let value; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HostingError('UI_RUNNER_GATEWAY_RECONCILIATION_INVALID'); }
    ensure(value.status === 'ok' && value.data?.batchId === this.state.request.batchId && ['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED'].includes(value.data.status), 'UI_RUNNER_GATEWAY_RECONCILIATION_INVALID');
    if (value.data.scope) ensure(scopeKey(value.data.scope) === scopeKey(this.state.request.scope), 'UI_RUNNER_SCOPE_MISMATCH');
    return value.data;
  }
  async control(path, method = 'GET') {
    const response = await this.ctx.container.getTcpPort(8080).fetch(new Request('http://container' + path, { method, headers: { Authorization: 'Bearer ' + this.state.runtimeToken }, signal: AbortSignal.timeout(5000) }));
    ensure(response.ok, 'UI_RUNNER_RUNTIME_CONTROL_UNAVAILABLE');
    const body = JSON.parse(new TextDecoder().decode(await readBytes(response, 16384)));
    ensure(body?.batchId === this.state.request.batchId && ['IDLE', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED'].includes(body.phase), 'UI_RUNNER_RUNTIME_STATUS_INVALID'); return body;
  }
  observeExit() {
    if (this.monitoring || !this.ctx.container.running) return;
    const monitoring = this.ctx.container.monitor().catch(() => {}).then(async () => {
      // Re-inspect instead of inferring success from process exit (exit 0 may
      // mean only that a runtime stopped). Persisted Gateway results decide.
      await this.schedule(1);
    }).finally(() => { if (this.monitoring === monitoring) this.monitoring = null; });
    this.monitoring = monitoring; this.ctx.waitUntil(monitoring);
  }
  async stop(nextPhase) {
    if (!this.ctx.container.running) { delete this.state.stopStartedAt; this.state.phase = nextPhase; await this.save(); if (terminal(this.state)) await this.ctx.storage.deleteAlarm(); else await this.schedule(); return; }
    if (!this.state.stopStartedAt) {
      this.state.stopStartedAt = this.now(); this.state.afterStop = nextPhase; await this.save();
      this.ctx.container.signal(15);
    } else if (this.now() - this.state.stopStartedAt >= STOP_MS) await this.ctx.container.destroy();
    await this.schedule(1000);
  }
  async alarm() { await this.ready; return this.tick(); }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.performTick().catch(async error => {
      if (!this.state) throw error;
      this.state.lastError = safeCode(error); this.state.updatedAt = this.now(); await this.save(); await this.schedule();
    }).finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async performTick() {
    if (!this.state) return;
    ensure(this.ctx.container, 'UI_RUNNER_CONTAINER_BINDING_NOT_CONFIGURED');
    if (this.state.stopStartedAt) return this.stop(this.state.afterStop ?? 'RECOVERING');
    if (terminal(this.state)) return this.stop(this.state.phase);
    const row = configuredScope(this.env, this.state.request.scope);
    if (!this.ctx.container.running) {
      const batch = await this.gatewayBatch(row);
      if (['COMPLETED', 'CANCELLED'].includes(batch.status)) { this.state.phase = batch.status; this.state.updatedAt = this.now(); await this.save(); await this.ctx.storage.deleteAlarm(); return; }
      this.state.phase = 'STARTING'; this.state.startedAt = this.now(); this.state.attempts++; this.state.updatedAt = this.now(); this.state.runtimeToken = this.randomToken(); await this.save();
      this.ctx.container.start({ enableInternet: true, env: {
        NODE_ENV: 'production', PORT: '8080', QAGENT_API_URL: row.apiUrl,
        QAGENT_PROJECT_ID: row.projectId, QAGENT_ENVIRONMENT_ID: row.environmentId, QAGENT_TOKEN: row.token,
        QAGENT_ORGANIZATION_ID: row.organizationId, QAGENT_HOSTED_BATCH_ID: this.state.request.batchId,
        QAGENT_HOSTED_CONTROL_TOKEN: this.state.runtimeToken,
        ...(row.configPath ? { QAGENT_RUNNER_CONFIG: row.configPath } : {})
      } });
    }
    await this.ctx.container.setInactivityTimeout(INACTIVITY_MS); this.observeExit();
    let status;
    try { status = await this.control('/status'); delete this.state.unreachableSince; }
    catch (error) {
      // A healthy long-running batch is never killed for a single failed probe.
      // Only initial readiness has a deadline; Gateway leases govern active work.
      if (this.state.phase === 'STARTING' && this.now() - this.state.startedAt >= STARTUP_MS) { this.state.lastError = 'UI_RUNNER_RUNTIME_START_TIMEOUT'; return this.stop('RECOVERING'); }
      if (this.state.phase === 'RUNNING') {
        let batch;
        try { batch = await this.gatewayBatch(row); delete this.state.unreachableSince; }
        catch (gatewayError) {
          this.state.unreachableSince ??= this.now();
          // Both paths have been unavailable continuously for much longer than
          // the 90s claim lease. End this runtime technically; no item is reset.
          if (this.now() - this.state.unreachableSince >= INFRASTRUCTURE_LOSS_MS) { this.state.lastError = 'UI_RUNNER_INFRASTRUCTURE_UNREACHABLE'; await this.save(); return this.stop('RECOVERING'); }
          throw gatewayError;
        }
        // A dead HTTP control port must not leave an idle/unresponsive process
        // billed forever after its claims have ended or the user cancelled.
        if (['COMPLETED', 'CANCELLED'].includes(batch.status)) { this.state.lastError = 'UI_RUNNER_RUNTIME_CONTROL_UNAVAILABLE'; this.state.phase = batch.status; await this.save(); return this.stop(batch.status); }
      }
      throw error;
    }
    if (status.phase === 'IDLE') { status = await this.control('/run', 'POST'); }
    this.state.updatedAt = this.now(); this.state.lastError = status.errorCode ?? null;
    if (status.phase === 'COMPLETED') {
      let batch;
      try { batch = await this.gatewayBatch(row); }
      catch (error) { this.state.lastError = safeCode(error); await this.save(); return this.stop('RECOVERING'); }
      ensure(['COMPLETED', 'CANCELLED'].includes(batch.status), 'UI_RUNNER_RUNTIME_COMPLETION_UNCONFIRMED');
      this.state.exitCode = status.exitCode; this.state.phase = batch.status; await this.save(); return this.stop(batch.status);
    }
    if (status.phase === 'FAILED') {
      // Do not rerun a failed claim. A replacement process asks the Gateway for
      // QUEUED work; expired/finished items retain their terminal state in D1.
      let batch;
      try { batch = await this.gatewayBatch(row); }
      catch (error) { this.state.lastError = safeCode(error); await this.save(); return this.stop('RECOVERING'); }
      const phase = ['COMPLETED', 'CANCELLED'].includes(batch.status) ? batch.status : 'RECOVERING';
      await this.save(); return this.stop(phase);
    }
    this.state.phase = 'RUNNING'; await this.save(); await this.schedule();
  }
}
