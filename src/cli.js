#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GatewayClient } from './client.js';
import { Worker } from './worker.js';
import { loadPreparations } from './preparation.js';
import { RunnerError, insist, codeOf } from './core.js';

const HELP = `QAgent UI Runner 0.2.0

create --profile ID --target-build REF (--all | --design-version ID [--design-version ID ...]) [--run]
run --batch ID
worker [--once]
report --batch ID

Required environment: QAGENT_API_URL, QAGENT_PROJECT_ID, QAGENT_ENVIRONMENT_ID, QAGENT_TOKEN.
Local preparation: --config FILE or QAGENT_RUNNER_CONFIG. Outputs: --output DIR (qagent-results).
CI: --operation-id ID pins admission; QAGENT_TARGET_BUILD_REF or --target-build pins target.
Exit: 0 passed, 1 assertions failed, 2 incomplete/blocked/technical, 130 cancelled.
create without --run confirms admission only, not a passing test result.
`;
function argumentsOf(argv) {
  const command = argv.shift(), flags = {};
  while (argv.length) {
    const key = argv.shift(); insist(key.startsWith('--'), 'UI_RUNNER_ARGUMENT_INVALID');
    if (['--all', '--run', '--once', '--help'].includes(key)) flags[key] = true;
    else { const value = argv.shift(); insist(value && !value.startsWith('--'), 'UI_RUNNER_ARGUMENT_VALUE_MISSING'); if (key === '--design-version') (flags[key] ??= []).push(value); else flags[key] = value; }
  }
  return { command, flags };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (!argv.length || argv.includes('--help')) { process.stdout.write(HELP); return 0; }
  const { command, flags } = argumentsOf([...argv]);
  insist(['create', 'run', 'worker', 'report'].includes(command), 'UI_RUNNER_COMMAND_INVALID');
  const client = new GatewayClient({ apiUrl: env.QAGENT_API_URL, projectId: env.QAGENT_PROJECT_ID, environmentId: env.QAGENT_ENVIRONMENT_ID, token: env.QAGENT_TOKEN });
  const preparations = await loadPreparations(flags['--config'] ?? env.QAGENT_RUNNER_CONFIG);
  const directory = resolve(flags['--output'] ?? 'qagent-results');
  const worker = new Worker({ client, preparations, directory, executablePath: env.QAGENT_CHROMIUM_EXECUTABLE });
  const controller = new AbortController();
  const stop = () => controller.abort(new RunnerError('UI_RUNNER_CANCELLED')); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'worker') { await worker.serve({ once: flags['--once'], signal: controller.signal }); return 0; }
    let batchId = flags['--batch'];
    if (command === 'create') {
      insist(flags['--profile'], 'UI_RUNNER_PROFILE_REQUIRED');
      const targetBuildRef = flags['--target-build'] ?? env.QAGENT_TARGET_BUILD_REF ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
      insist(targetBuildRef, 'UI_RUNNER_TARGET_BUILD_REQUIRED');
      insist(Boolean(flags['--all']) !== Boolean(flags['--design-version']), 'UI_RUNNER_DESIGN_SELECTION_REQUIRED');
      let testDesignVersionIds = flags['--design-version'];
      if (flags['--all']) {
        const inventory = await client.inventory(); insist(inventory.inventoryComplete === true, 'UI_RUNNER_INVENTORY_INCOMPLETE');
        const eligible = inventory.items.filter(i => i.executable === true);
        testDesignVersionIds = eligible.map(i => i.testDesignVersionId);
        process.stdout.write(JSON.stringify({ event: 'ui.inventory.resolved', selected: eligible.length, skipped: inventory.items.length - eligible.length, diagnostics: inventory.diagnostics ?? [] }) + '\n');
      }
      insist(testDesignVersionIds.length > 0, 'UI_RUNNER_NO_DESIGNS');
      let body = { operationId: flags['--operation-id'] ?? 'uiexop_' + randomUUID(), testDesignVersionIds, profileId: flags['--profile'], targetBuildRef };
      insist(/^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/.test(body.operationId), 'UI_RUNNER_OPERATION_ID_INVALID');
      if (env.CI) body.trigger = { kind: 'CI', provider: env.GITHUB_ACTIONS ? 'GITHUB_ACTIONS' : env.GITLAB_CI ? 'GITLAB_CI' : 'GENERIC', ...(env.GITHUB_SHA ?? env.CI_COMMIT_SHA ? { commitSha: env.GITHUB_SHA ?? env.CI_COMMIT_SHA } : {}), ...(env.GITHUB_REF_NAME ?? env.CI_COMMIT_REF_NAME ? { branch: env.GITHUB_REF_NAME ?? env.CI_COMMIT_REF_NAME } : {}), ...(env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID ? { pipelineRunId: env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID } : {}) };
      const admissions = join(directory, 'admissions'); await mkdir(admissions, { recursive: true });
      const admissionPath = join(admissions, body.operationId + '.json');
      let existing;
      try { existing = JSON.parse(await readFile(admissionPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        insist(existing.projectId === env.QAGENT_PROJECT_ID && existing.environmentId === env.QAGENT_ENVIRONMENT_ID && existing.body.profileId === body.profileId && existing.body.targetBuildRef === body.targetBuildRef, 'UI_RUNNER_OPERATION_CONFLICT');
        if (!flags['--all']) insist(JSON.stringify(existing.body.testDesignVersionIds) === JSON.stringify(body.testDesignVersionIds), 'UI_RUNNER_OPERATION_CONFLICT');
        body = existing.body;
      } else await writeFile(admissionPath, JSON.stringify({ projectId: env.QAGENT_PROJECT_ID, environmentId: env.QAGENT_ENVIRONMENT_ID, body }, null, 2), { mode: 0o600, flag: 'wx' });
      const batch = await client.create(body); batchId = batch.batchId;
      process.stdout.write(JSON.stringify({ event: 'ui.batch.admitted', batchId, operationId: body.operationId, itemCount: batch.itemCount, executionPerformed: false }) + '\n');
      if (!flags['--run']) return 0;
    }
    insist(batchId, 'UI_RUNNER_BATCH_REQUIRED');
    if (command === 'report') {
      await mkdir(directory, { recursive: true });
      for (const format of ['json', 'junit']) await writeFile(join(directory, format === 'json' ? 'report.json' : 'junit.xml'), await client.report(batchId, format), { mode: 0o600 });
      return 0;
    }
    return (await worker.runBatch(batchId, { signal: controller.signal })).exitCode;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { const code = codeOf(error); process.stderr.write(JSON.stringify({ status: 'error', code, details: error.details ?? {} }) + '\n'); process.exitCode = code === 'UI_RUNNER_CANCELLED' ? 130 : 2; });
}
