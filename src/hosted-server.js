import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GatewayClient } from './client.js';
import { Worker } from './worker.js';
import { loadPreparations } from './preparation.js';
import { hostedConfig } from './hosted-config.js';
import { RunnerError, codeOf } from './core.js';

export function authorized(header, token) {
  const actual = Buffer.from(header ?? ''), expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export class HostedRuntime {
  constructor(config, { workerFactory, now = Date.now, log = entry => process.stdout.write(JSON.stringify(entry) + '\n') } = {}) {
    Object.assign(this, { config, now, log });
    this.workerFactory = workerFactory ?? (async () => new Worker({
      client: new GatewayClient({ apiUrl: config.apiUrl, projectId: config.scope.projectId, environmentId: config.scope.environmentId, token: config.token }),
      preparations: await loadPreparations(config.configFile), directory: config.directory, executablePath: config.executablePath, log
    }));
    this.phase = 'IDLE'; this.startedAt = null; this.completedAt = null; this.errorCode = null; this.exitCode = null;
  }
  status() { return { contractVersion: 'qagent.ui-runner-runtime.v1', batchId: this.config.batchId, phase: this.phase, startedAt: this.startedAt, completedAt: this.completedAt, errorCode: this.errorCode, exitCode: this.exitCode }; }
  start() {
    if (this.phase !== 'IDLE') return this.status();
    this.controller = new AbortController(); this.phase = 'RUNNING'; this.startedAt = this.now();
    this.work = Promise.resolve().then(async () => {
      const worker = await this.workerFactory();
      const result = await worker.runBatch(this.config.batchId, { signal: this.controller.signal });
      this.exitCode = result.exitCode; this.phase = 'COMPLETED';
    }).catch(error => {
      this.errorCode = codeOf(error, 'UI_RUNNER_HOSTED_EXECUTION_FAILED'); this.phase = 'FAILED'; this.exitCode = this.errorCode === 'UI_RUNNER_CANCELLED' ? 130 : 2;
      this.log({ event: 'ui.hosted.failed', batchId: this.config.batchId, code: this.errorCode });
    }).finally(() => { this.completedAt = this.now(); });
    return this.status();
  }
  cancel(reason = 'UI_RUNNER_CANCELLED') {
    if (this.phase === 'RUNNING') { this.phase = 'CANCELLING'; this.controller.abort(new RunnerError(reason)); }
    return this.status();
  }
}
export function createHostedServer(config, options) {
  const runtime = new HostedRuntime(config, options);
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json');
    const send = (status, value) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (!authorized(request.headers.authorization, config.controlToken)) { request.resume(); send(401, { code: 'UI_RUNNER_RUNTIME_UNAUTHORIZED' }); return; }
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0) { request.resume(); send(400, { code: 'UI_RUNNER_RUNTIME_BODY_UNEXPECTED' }); return; }
    if (request.method === 'GET' && ['/health', '/status'].includes(request.url)) return send(200, runtime.status());
    if (request.method === 'POST' && request.url === '/run') return send(202, runtime.start());
    if (request.method === 'POST' && request.url === '/cancel') return send(202, runtime.cancel());
    send(404, { code: 'UI_RUNNER_RUNTIME_NOT_FOUND' });
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
  return { server, runtime };
}
export async function main(env = process.env) {
  const config = hostedConfig(env), { server, runtime } = createHostedServer(config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  process.stdout.write(JSON.stringify({ event: 'ui.hosted.ready', batchId: config.batchId }) + '\n');
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    // A host lifecycle event is a technical interruption, not a user cancel.
    runtime.cancel('UI_RUNNER_HOST_SHUTDOWN');
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(2); }, 25000); deadline.unref();
    await runtime.work; server.closeIdleConnections();
    server.close(() => { clearTimeout(deadline); process.exitCode = runtime.phase === 'FAILED' ? 2 : 0; });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { server, runtime };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(JSON.stringify({ status: 'error', code: codeOf(error, 'UI_RUNNER_HOSTED_START_FAILED') }) + '\n'); process.exitCode = 2; });
