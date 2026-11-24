export const PREFIX = '/internal/ui-runner/v1/';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/;
const encoder = new TextEncoder();
export class HostingError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export const ensure = (test, code, status) => { if (!test) throw new HostingError(code, status); };
export const safeCode = (error, fallback = 'UI_RUNNER_HOSTING_UNAVAILABLE') => /^[A-Z0-9_]{1,128}$/.test(error?.code ?? '') ? error.code : fallback;
export function reply(data, status = 200) { return Response.json({ status: 'ok', data }, { status, headers: { 'Cache-Control': 'no-store' } }); }
export function rejected(error) { return Response.json({ status: 'error', code: safeCode(error), message: safeCode(error) }, { status: error.status ?? 503, headers: { 'Cache-Control': 'no-store' } }); }
export const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const hash = async bytes => hex(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? encoder.encode(bytes) : bytes));
export const scopeKey = scope => [scope.organizationId, scope.projectId, scope.environmentId].join('/');
export function validateScope(scope) {
  ensure(scope && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length === 3 && ['organizationId', 'projectId', 'environmentId'].every(k => typeof scope[k] === 'string' && ID.test(scope[k])), 'UI_RUNNER_SCOPE_INVALID', 400);
  return scope;
}
export function validateDispatch(body) {
  ensure(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => ['contractVersion', 'scope', 'batchId'].includes(k)), 'UI_RUNNER_DISPATCH_INVALID', 400);
  ensure(body.contractVersion === 'qagent.ui-runner-dispatch.v1' && typeof body.batchId === 'string' && ID.test(body.batchId), 'UI_RUNNER_DISPATCH_INVALID', 400);
  validateScope(body.scope); return body;
}
export function configuredScope(env, scope) {
  let rows; try { rows = JSON.parse(env.UI_RUNNER_SCOPES_JSON ?? 'null'); } catch { throw new HostingError('UI_RUNNER_SCOPES_CONFIG_INVALID'); }
  ensure(Array.isArray(rows) && rows.length > 0, 'UI_RUNNER_SCOPES_NOT_CONFIGURED');
  const seen = new Set(); let selected;
  for (const row of rows) {
    ensure(row && typeof row === 'object' && Object.keys(row).every(k => ['organizationId', 'projectId', 'environmentId', 'apiUrl', 'token', 'configPath'].includes(k)), 'UI_RUNNER_SCOPES_CONFIG_INVALID');
    const s = { organizationId: row.organizationId, projectId: row.projectId, environmentId: row.environmentId };
    try { validateScope(s); } catch { throw new HostingError('UI_RUNNER_SCOPES_CONFIG_INVALID'); }
    const key = scopeKey(s); ensure(!seen.has(key), 'UI_RUNNER_SCOPE_CONFIG_DUPLICATED'); seen.add(key);
    ensure(typeof row.token === 'string' && /^[A-Za-z0-9._~-]{32,512}$/.test(row.token), 'UI_RUNNER_SCOPE_TOKEN_INVALID');
    let url; try { url = new URL(row.apiUrl); } catch { throw new HostingError('UI_RUNNER_GATEWAY_URL_INVALID'); }
    ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'UI_RUNNER_GATEWAY_URL_INVALID');
    if (row.configPath !== undefined) ensure(/^\/app\/hosted-config\/[A-Za-z0-9_./-]+\.json$/.test(row.configPath) && !row.configPath.split('/').includes('..'), 'UI_RUNNER_PREPARATION_PATH_INVALID');
    if (key === scopeKey(scope)) selected = { ...row, apiUrl: url.origin };
  }
  ensure(selected, 'UI_RUNNER_SCOPE_NOT_CONFIGURED'); return selected;
}
export async function readBytes(response, maxBytes = 4096) {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  let size = 0; const pieces = [];
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; ensure(size <= maxBytes, 'UI_RUNNER_REQUEST_TOO_LARGE', 413); pieces.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; } return bytes;
}
export async function verifyRequest(request, secret, bytes, now = Date.now()) {
  ensure(typeof secret === 'string' && secret.length >= 32 && secret.length <= 512, 'UI_RUNNER_DISPATCH_AUTH_NOT_CONFIGURED');
  const time = request.headers.get('X-QAgent-Runner-Time'), signature = request.headers.get('X-QAgent-Runner-Signature');
  ensure(/^\d{10,12}$/.test(time ?? '') && Math.abs(Math.floor(now / 1000) - Number(time)) <= 300 && /^[a-f0-9]{64}$/.test(signature ?? ''), 'UI_RUNNER_DISPATCH_UNAUTHORIZED', 401);
  const pathname = new URL(request.url).pathname;
  const value = `QAGENT_UI_RUNNER_HTTP_V1\n${request.method}\n${pathname}\n${time}\n${await hash(bytes)}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(signature.match(/../g), x => parseInt(x, 16));
  ensure(await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(value)), 'UI_RUNNER_DISPATCH_UNAUTHORIZED', 401);
}
export async function route(request, env) {
  try {
    const url = new URL(request.url), action = url.pathname.slice(PREFIX.length);
    if (url.hostname !== 'qagent-ui-runner.internal' || request.method !== 'POST' || !url.pathname.startsWith(PREFIX) || !['dispatch', 'status'].includes(action) || url.search) return new Response('Not found', { status: 404 });
    const bytes = await readBytes(request);
    await verifyRequest(request, env.UI_RUNNER_DISPATCH_SECRET, bytes);
    let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HostingError('UI_RUNNER_DISPATCH_INVALID', 400); }
    validateDispatch(body); configuredScope(env, body.scope);
    ensure(env.UI_RUNNER_CONTAINERS?.getByName, 'UI_RUNNER_CONTAINER_BINDING_NOT_CONFIGURED');
    const key = await hash(scopeKey(body.scope) + '/' + body.batchId);
    return env.UI_RUNNER_CONTAINERS.getByName(key).fetch(new Request('http://container-control/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  } catch (error) { return rejected(error); }
}
