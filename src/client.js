import { RunnerError, insist, sha256, sleep, checkAbort } from './core.js';
import { parseStrictJson } from './strict-json.js';

export async function responseBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared) insist(declared <= maxBytes, 'UI_RUNNER_RESPONSE_SIZE_LIMIT');
  const reader = response.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; insist(size <= maxBytes, 'UI_RUNNER_RESPONSE_SIZE_LIMIT'); parts.push(Buffer.from(value));
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}
export class GatewayClient {
  constructor({ apiUrl, projectId, environmentId, token, fetchImpl = fetch, timeoutMs = 30000, evidenceTimeoutMs = 60000, maxRetries = 2 }) {
    const url = new URL(apiUrl);
    insist(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'UI_RUNNER_GATEWAY_URL_INVALID');
    insist(typeof token === 'string' && /^[A-Za-z0-9._~-]{32,512}$/.test(token), 'UI_RUNNER_AUTOMATION_TOKEN_REQUIRED');
    for (const id of [projectId, environmentId]) insist(/^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/.test(id), 'UI_RUNNER_SCOPE_REQUIRED');
    this.base = url.href.replace(/\/$/, '') + '/v1/automation/projects/' + projectId + '/environments/' + environmentId + '/ui-executions';
    this.token = token; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.evidenceTimeoutMs = evidenceTimeoutMs; this.maxRetries = maxRetries;
  }
  async request(path, { method = 'GET', body, binary, headers = {}, raw = false, maxBytes = 64 * 1024 * 1024, retry = true, signal, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal); const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await this.fetch(this.base + path, { method, redirect: 'error', signal: combined, headers: { Authorization: 'Bearer ' + this.token, ...(binary ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: binary ?? (body === undefined ? undefined : JSON.stringify(body)) });
        if (response.status >= 500 || response.status === 429) {
          await response.body?.cancel().catch(() => {});
          if (retry && attempt < this.maxRetries) { await sleep(250 * 2 ** attempt, signal); continue; }
          throw new RunnerError('UI_RUNNER_GATEWAY_UNAVAILABLE', { httpStatus: response.status });
        }
        const bytes = await responseBytes(response, maxBytes);
        if (response.ok && raw) return bytes;
        let envelope; try { envelope = parseStrictJson(bytes); } catch { throw new RunnerError('UI_RUNNER_GATEWAY_RESPONSE_INVALID', { httpStatus: response.status }); }
        if (!response.ok || envelope.status !== 'ok') throw new RunnerError(/^[A-Z0-9_]{1,128}$/.test(envelope.code ?? '') ? envelope.code : 'UI_RUNNER_GATEWAY_REJECTED', { httpStatus: response.status });
        return envelope.data;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new RunnerError('UI_RUNNER_CANCELLED');
        if (!(error instanceof RunnerError) && retry && attempt < this.maxRetries) { await sleep(250 * 2 ** attempt, signal); continue; }
        if (!(error instanceof RunnerError)) throw new RunnerError(timeout.aborted ? 'UI_RUNNER_TRANSPORT_TIMEOUT' : 'UI_RUNNER_TRANSPORT_FAILED', {}, { cause: error });
        throw error;
      }
    }
  }
  profiles() { return this.request('/profiles'); }
  inventory() { return this.request('/inventory'); }
  create(body) { return this.request('/batches', { method: 'POST', body }); }
  batch(id) { return this.request('/batches/' + encodeURIComponent(id)); }
  batches(cursor) { return this.request('/batches?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); }
  cancel(id) { return this.request('/batches/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} }); }
  claim(id, workerId) { return this.request('/batches/' + encodeURIComponent(id) + '/claim', { method: 'POST', body: { workerId }, retry: false }); }
  itemPath(claim) { return '/batches/' + encodeURIComponent(claim.batchId) + '/items/' + encodeURIComponent(claim.itemId); }
  heartbeat(claim) { return this.request(this.itemPath(claim) + '/heartbeat', { method: 'POST', body: { claimToken: claim.claimToken } }); }
  source(claim, signal) { return this.request(this.itemPath(claim) + '/source', { method: 'POST', body: { claimToken: claim.claimToken }, signal, timeoutMs: this.evidenceTimeoutMs }); }
  artifact(claim, artifactId, options) { return this.request(this.itemPath(claim) + '/artifacts/' + encodeURIComponent(artifactId), { method: 'POST', body: { claimToken: claim.claimToken }, raw: true, timeoutMs: this.evidenceTimeoutMs, ...options }); }
  result(claim, result) { return this.request(this.itemPath(claim) + '/result', { method: 'POST', body: { claimToken: claim.claimToken, result } }); }
  evidence(claim, ref, bytes) {
    insist(bytes.length === ref.byteLength && sha256(bytes) === ref.sha256, 'UI_RUNNER_UPLOAD_HASH_MISMATCH');
    return this.request(this.itemPath(claim) + '/evidence/' + encodeURIComponent(ref.evidenceId), { method: 'POST', binary: bytes, headers: { 'Content-Type': ref.contentType, 'X-QAgent-Claim-Token': claim.claimToken, 'X-QAgent-SHA256': ref.sha256 } });
  }
  report(id, format) { return this.request('/batches/' + encodeURIComponent(id) + '/report?format=' + format, { raw: true }); }
}
