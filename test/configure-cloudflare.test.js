import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { configure, recover } from '../scripts/configure-cloudflare.mjs';

test('bootstrap generates matching credentials without rotation, retains other scopes and existing auth choices', async t => {
  const output = await mkdtemp(join(tmpdir(), 'qagent-cloud-config-')); t.after(() => rm(output, { recursive: true, force: true }));
  const opts = { output, organizationId: 'org_test', projectId: 'prj_test', environmentId: 'env_stg', targetBaseUrl: 'https://stg.example.test' };
  const result = await configure(opts);
  const firstG = JSON.parse(await readFile(result.gatewayPath, 'utf8')), firstR = JSON.parse(await readFile(result.runnerPath, 'utf8'));
  const token = JSON.parse(firstR.UI_RUNNER_SCOPES_JSON)[0].token;
  assert.equal(firstG.UI_RUNNER_DISPATCH_SECRET, firstR.UI_RUNNER_DISPATCH_SECRET);
  assert.equal(JSON.parse(firstG.UI_EXECUTION_TOKENS_JSON)[0].tokenSha256, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.parse(firstG.UI_EXECUTION_PROFILES_JSON)[0].preparationMode, 'UNAUTHENTICATED');
  assert.ok(!JSON.stringify(result).includes(token));
  await configure(opts); assert.deepEqual(JSON.parse(await readFile(result.gatewayPath, 'utf8')), firstG);
  await configure({ ...opts, environmentId: 'env_dev', targetBaseUrl: 'https://dev.example.test' });
  const secondG = JSON.parse(await readFile(result.gatewayPath, 'utf8')); assert.equal(JSON.parse(secondG.UI_EXECUTION_PROFILES_JSON).length, 2);
  const profiles = JSON.parse(secondG.UI_EXECUTION_PROFILES_JSON); profiles[0].preparationMode = 'REQUIRE_ADAPTER'; profiles[0].preparationKey = 'authenticated'; secondG.UI_EXECUTION_PROFILES_JSON = JSON.stringify(profiles);
  await writeFile(result.gatewayPath, JSON.stringify(secondG)); await configure(opts);
  assert.equal(JSON.parse(JSON.parse(await readFile(result.gatewayPath, 'utf8')).UI_EXECUTION_PROFILES_JSON)[0].preparationMode, 'REQUIRE_ADAPTER');
  await assert.rejects(configure({ ...opts, targetBaseUrl: 'https://different.example.test' }), /Existing profile target differs/);
});
test('bootstrap refuses conflicting shared secrets and resumes interrupted writes from saved exact values', async t => {
  const output = await mkdtemp(join(tmpdir(), 'qagent-cloud-recover-')); t.after(() => rm(output, { recursive: true, force: true }));
  const opts = { output, organizationId: 'org_test', projectId: 'prj_test', environmentId: 'env_stg', targetBaseUrl: 'https://stg.example.test' };
  const paths = await configure(opts), statePath = join(output, 'configuration-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')); state.pending = true; await writeFile(statePath, JSON.stringify(state));
  // Interruption can leave one export from the preceding configuration.
  await writeFile(paths.runnerPath, JSON.stringify({ ...state.runner, UI_RUNNER_DISPATCH_SECRET: 'z'.repeat(48) }));
  await assert.rejects(configure(opts), /interrupted configuration/);
  await recover(output); assert.deepEqual(JSON.parse(await readFile(paths.gatewayPath, 'utf8')), state.gateway);
  const wrong = JSON.parse(await readFile(paths.runnerPath, 'utf8')); wrong.UI_RUNNER_DISPATCH_SECRET = 'a'.repeat(48); await writeFile(paths.runnerPath, JSON.stringify(wrong));
  await assert.rejects(configure(opts), /Dispatch secrets differ/);
});
test('bootstrap rejects missing explicit exports and invalid viewport, and reports legacy auth without downgrading it', async t => {
  const output = await mkdtemp(join(tmpdir(), 'qagent-cloud-config-invalid-')); t.after(() => rm(output, { recursive: true, force: true }));
  const opts = { output, organizationId: 'org_test', projectId: 'prj_test', environmentId: 'env_stg', targetBaseUrl: 'https://stg.example.test' };
  await assert.rejects(configure({ ...opts, gatewaySecrets: join(output, 'missing-gateway.json') }), { code: 'ENOENT' });
  await assert.rejects(configure({ ...opts, runnerSecrets: join(output, 'missing-runner.json') }), { code: 'ENOENT' });
  await assert.rejects(configure({ ...opts, viewport: '100x100' }), /between 240 and 7680/);
  const result = await configure(opts);
  const gateway = JSON.parse(await readFile(result.gatewayPath, 'utf8'));
  const profiles = JSON.parse(gateway.UI_EXECUTION_PROFILES_JSON);
  delete profiles[0].preparationMode;
  profiles[0].preparationKey = 'existing_authenticated_adapter';
  gateway.UI_EXECUTION_PROFILES_JSON = JSON.stringify(profiles);
  await writeFile(result.gatewayPath, JSON.stringify(gateway));
  const updated = await configure(opts);
  assert.equal(updated.authentication, 'REQUIRE_ADAPTER');
  const preserved = JSON.parse(JSON.parse(await readFile(result.gatewayPath, 'utf8')).UI_EXECUTION_PROFILES_JSON)[0];
  assert.equal(preserved.preparationMode, undefined);
  assert.equal(preserved.preparationKey, 'existing_authenticated_adapter');
});
