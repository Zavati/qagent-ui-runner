#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = message => { throw new Error(message); };
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
const arraySecret = (doc, key) => {
  const value = doc[key] === undefined ? [] : JSON.parse(doc[key]);
  if (!Array.isArray(value)) failure(key + ' must contain a JSON array'); return value;
};
function origin(raw, name) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') failure(name + ' must be an HTTPS origin without path, query, or credentials');
  return url.origin;
}
async function atomic(path, data) {
  const temp = path + '.tmp'; await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path); await chmod(path, 0o600);
}
export async function configure(options) {
  const scope = { organizationId: options.organizationId, projectId: options.projectId, environmentId: options.environmentId };
  if (!Object.values(scope).every(x => typeof x === 'string' && ID.test(x))) failure('organization-id, project-id and environment-id are required');
  const apiUrl = origin(options.apiUrl ?? 'https://api.apiqagent.com', 'api-url');
  const targetBaseUrl = origin(options.targetBaseUrl, 'target-base-url');
  const profileId = options.profileId ?? 'profile_stg_chromium'; if (!ID.test(profileId)) failure('profile-id is invalid');
  const directory = resolve(options.output ?? 'private-cloudflare');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.gitignore'), '*\n', { mode: 0o600 });
  const statePath = join(directory, 'configuration-state.json');
  const previous = await readJson(statePath, null);
  if (previous?.pending) failure('An interrupted configuration is pending. Run --recover to finish writing its exact files.');
  // Supply existing secret-file exports when adding hosting to a configured
  // account. No remote secret read, rotation, or deployment occurs here.
  const gatewayPath = join(directory, 'gateway-secrets.json'), runnerPath = join(directory, 'runner-secrets.json');
  const gateway = await readJson(options.gatewaySecrets ?? gatewayPath, options.gatewaySecrets ? undefined : {});
  const runner = await readJson(options.runnerSecrets ?? runnerPath, options.runnerSecrets ? undefined : {});
  if (!gateway || !runner || Array.isArray(gateway) || Array.isArray(runner) || typeof gateway !== 'object' || typeof runner !== 'object') failure('Secrets files must be objects');
  const profiles = arraySecret(gateway, 'UI_EXECUTION_PROFILES_JSON');
  const tokens = arraySecret(gateway, 'UI_EXECUTION_TOKENS_JSON');
  const scopes = arraySecret(runner, 'UI_RUNNER_SCOPES_JSON');
  const sameScope = row => row?.organizationId === scope.organizationId && row?.projectId === scope.projectId && row?.environmentId === scope.environmentId;
  const matching = scopes.filter(sameScope); if (matching.length > 1) failure('Duplicated runner scope; resolve the existing config first');
  const dispatchSecrets = [gateway.UI_RUNNER_DISPATCH_SECRET, runner.UI_RUNNER_DISPATCH_SECRET].filter(Boolean);
  if (dispatchSecrets.length === 2 && dispatchSecrets[0] !== dispatchSecrets[1]) failure('Dispatch secrets differ; choose the correct existing value in both files');
  const dispatchSecret = dispatchSecrets[0] ?? randomBytes(48).toString('base64url');
  if (typeof dispatchSecret !== 'string' || dispatchSecret.length < 32 || dispatchSecret.length > 512) failure('Existing dispatch secret is invalid');
  const token = matching[0]?.token ?? randomBytes(48).toString('base64url');
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) failure('Existing scoped token is invalid');
  const scopeRow = { ...(matching[0] ?? {}), ...scope, apiUrl, token };
  if (matching.length) scopes[scopes.indexOf(matching[0])] = scopeRow; else scopes.push(scopeRow);
  const tokenSha256 = hash(token), tokenRows = tokens.filter(r => r.tokenSha256 === tokenSha256);
  if (tokenRows.length > 1 || tokenRows.some(r => !sameScope(r))) failure('Existing token hash has ambiguous or foreign scope');
  if (tokenRows.length && !['read', 'execute'].every(p => tokenRows[0].permissions?.includes(p))) failure('Existing runner token requires read and execute permissions');
  if (!tokenRows.length) tokens.push({ ...scope, tokenSha256, permissions: ['read', 'create', 'execute'] });
  const currentProfile = profiles.find(p => p.profileId === profileId && sameScope(p.scope));
  if (currentProfile) {
    if (new URL(currentProfile.targetBaseUrl).origin !== targetBaseUrl) failure('Existing profile target differs; use another profile-id for the new target');
    // Existing auth/preparation choices are retained; never silently downgrade.
  } else {
    const [width, height] = (options.viewport ?? '1280x720').split('x').map(Number);
    if (![width, height].every(v => Number.isSafeInteger(v) && v >= 240 && v <= 7680)) failure('viewport must be WIDTHxHEIGHT, with each dimension between 240 and 7680');
    const extra = options.allowedOrigins ? options.allowedOrigins.split(',').map(x => origin(x.trim(), 'allowed-origins')) : [];
    profiles.push({ profileId, name: options.name ?? 'STG Chromium', scope, targetBaseUrl,
      allowedOrigins: [...new Set([targetBaseUrl, ...extra])], preparationKey: 'unauthenticated', preparationMode: 'UNAUTHENTICATED',
      viewport: { width, height }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', stepTimeoutMs: 7000, modeTimeoutMs: 600000 });
  }
  Object.assign(gateway, { UI_RUNNER_DISPATCH_SECRET: dispatchSecret, UI_EXECUTION_PROFILES_JSON: JSON.stringify(profiles), UI_EXECUTION_TOKENS_JSON: JSON.stringify(tokens) });
  Object.assign(runner, { UI_RUNNER_DISPATCH_SECRET: dispatchSecret, UI_RUNNER_SCOPES_JSON: JSON.stringify(scopes) });
  // Write a resumable source before either export, so an interruption cannot
  // generate incompatible credentials on the next invocation.
  await atomic(statePath, { pending: true, gateway, runner });
  await atomic(runnerPath, runner); await atomic(gatewayPath, gateway);
  await atomic(statePath, { pending: false, gateway, runner });
  return { gatewayPath, runnerPath, profileId, organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId, authentication: currentProfile ? (currentProfile.preparationMode ?? 'REQUIRE_ADAPTER') : 'UNAUTHENTICATED' };
}
export async function recover(output = 'private-cloudflare') {
  const directory = resolve(output), statePath = join(directory, 'configuration-state.json'), state = await readJson(statePath, null);
  if (!state?.gateway || !state?.runner) failure('No saved configuration is available to recover');
  await atomic(join(directory, 'runner-secrets.json'), state.runner); await atomic(join(directory, 'gateway-secrets.json'), state.gateway);
  await atomic(statePath, { ...state, pending: false });
  return { recovered: true, directory };
}
export async function main(args = process.argv.slice(2)) {
  const options = {}, allowed = new Set(['organization-id','project-id','environment-id','api-url','target-base-url','profile-id','name','output','gateway-secrets','runner-secrets','viewport','allowed-origins']);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/configure-cloudflare.mjs --organization-id org_ID --project-id prj_ID --environment-id env_ID --target-base-url https://stg.example.test [--profile-id profile_stg_chromium] [--allowed-origins https://api.stg.example.test] [--output private-cloudflare]\nExisting arrays are preserved when --gateway-secrets FILE and --runner-secrets FILE are supplied. Keep these files private. No deployment is performed.\nRecovery: --recover [--output private-cloudflare]\n'); return;
  }
  let recovery = false;
  while (args.length) {
    const flag = args.shift(); if (flag === '--recover') { recovery = true; continue; }
    const key = flag?.replace(/^--/, ''), value = args.shift();
    if (!flag?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--')) failure('Invalid or missing argument: ' + flag);
    options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  const result = recovery ? await recover(options.output) : await configure(options);
  process.stdout.write(JSON.stringify({ status: 'ok', ...result, secretsPrinted: false }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
