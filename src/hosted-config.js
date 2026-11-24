import { insist } from './core.js';

export function hostedConfig(env = process.env) {
  for (const key of ['QAGENT_ORGANIZATION_ID', 'QAGENT_PROJECT_ID', 'QAGENT_ENVIRONMENT_ID', 'QAGENT_HOSTED_BATCH_ID']) insist(/^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/.test(env[key] ?? ''), 'UI_RUNNER_HOSTED_SCOPE_REQUIRED');
  insist(/^[A-Za-z0-9._~-]{32,512}$/.test(env.QAGENT_HOSTED_CONTROL_TOKEN ?? ''), 'UI_RUNNER_HOSTED_CONTROL_TOKEN_REQUIRED');
  const port = Number(env.PORT ?? 8080); insist(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'UI_RUNNER_HOSTED_PORT_INVALID');
  return {
    port, host: '0.0.0.0', batchId: env.QAGENT_HOSTED_BATCH_ID,
    scope: { organizationId: env.QAGENT_ORGANIZATION_ID, projectId: env.QAGENT_PROJECT_ID, environmentId: env.QAGENT_ENVIRONMENT_ID },
    apiUrl: env.QAGENT_API_URL, token: env.QAGENT_TOKEN, controlToken: env.QAGENT_HOSTED_CONTROL_TOKEN,
    configFile: env.QAGENT_RUNNER_CONFIG, directory: env.QAGENT_RUNNER_OUTPUT ?? '/app/qagent-results', executablePath: env.QAGENT_CHROMIUM_EXECUTABLE
  };
}
