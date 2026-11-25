import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { insist, RunnerError, validOrigin, same, abortable } from './core.js';

export async function loadPreparations(configFile) {
  if (!configFile) return { preparations: {}, directory: process.cwd() };
  const path = await realpath(configFile), text = await readFile(path, 'utf8');
  insist(Buffer.byteLength(text) <= 1024 * 1024, 'UI_RUNNER_LOCAL_CONFIG_TOO_LARGE');
  const config = JSON.parse(text);
  insist(config && typeof config.preparations === 'object' && !Array.isArray(config.preparations), 'UI_RUNNER_LOCAL_CONFIG_INVALID');
  return { ...config, directory: dirname(path) };
}
async function localPath(config, path) {
  insist(typeof path === 'string' && path.length > 0, 'UI_RUNNER_LOCAL_PREPARATION_PATH_INVALID');
  const actual = await realpath(resolve(config.directory, path));
  const rel = relative(config.directory, actual);
  insist(rel && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel), 'UI_RUNNER_LOCAL_PREPARATION_PATH_OUTSIDE_CONFIG');
  return actual;
}
export async function resolvePreparation(config, profile, mode) {
  if (profile.preparationMode === 'UNAUTHENTICATED') {
    // An explicit environment choice, never a successful login/seed/build check.
    // Keep both browser modes runnable while reporting the missing prerequisites.
    return { storageState: undefined, pendingReasons: [
      'UI_RUNNER_AUTHENTICATION_NOT_CONFIGURED',
      'UI_RUNNER_TARGET_BUILD_UNVERIFIED',
      'UI_RUNNER_BASELINE_STATE_UNPREPARED',
      ...(mode === 'UI_LIVE' ? ['UI_RUNNER_LIVE_STATE_NOT_PREPARED'] : []),
    ], async run() { return { ready: false, baselineReady: false, verifiedTargetBuildRef: null, liveStatePrepared: false }; } };
  }
  if (profile.preparationMode === 'BROWSER_AUTH') {
    const auth = profile.browserAuth;
    insist(auth && typeof auth.authProfileId === 'string' && auth.config, 'UI_RUNNER_BROWSER_AUTH_INVALID');
    const cfg = auth.config;
    insist(typeof cfg.loginPath === 'string' && cfg.loginPath.startsWith('/') && !cfg.loginPath.startsWith('//'), 'UI_RUNNER_BROWSER_AUTH_INVALID');
    const loginUrl = new URL(cfg.loginPath, profile.targetBaseUrl);
    insist(loginUrl.origin === new URL(profile.targetBaseUrl).origin && !loginUrl.username && !loginUrl.password && !loginUrl.hash, 'UI_RUNNER_BROWSER_AUTH_ORIGIN_INVALID');
    for (const key of ['usernameSelector','passwordSelector','submitSelector','successSelector'])
      insist(typeof cfg[key] === 'string' && cfg[key].length > 0 && cfg[key].length <= 200, 'UI_RUNNER_BROWSER_AUTH_SELECTOR_INVALID');
    return { storageState: undefined,
      pendingReasons: ['UI_RUNNER_TARGET_BUILD_UNVERIFIED', 'UI_RUNNER_BASELINE_STATE_UNPREPARED', ...(mode === 'UI_LIVE' ? ['UI_RUNNER_LIVE_STATE_NOT_PREPARED'] : [])],
      async run({ page, claim, authProvider, signal }) {
        insist(typeof authProvider === 'function', 'UI_RUNNER_BROWSER_AUTH_PROVIDER_REQUIRED');
        let credentials;
        try {
          credentials = await authProvider(claim, signal);
          insist(typeof credentials?.username === 'string' && typeof credentials?.password === 'string', 'UI_RUNNER_BROWSER_AUTH_CREDENTIALS_INVALID');
          await page.goto(loginUrl.href, { waitUntil: 'domcontentloaded', timeout: profile.stepTimeoutMs });
          await page.locator(cfg.usernameSelector).fill(credentials.username, { timeout: profile.stepTimeoutMs });
          await page.locator(cfg.passwordSelector).fill(credentials.password, { timeout: profile.stepTimeoutMs });
          await page.locator(cfg.submitSelector).click({ timeout: profile.stepTimeoutMs });
          await page.locator(cfg.successSelector).waitFor({ state: 'visible', timeout: profile.stepTimeoutMs });
          return { ready: true, baselineReady: false, verifiedTargetBuildRef: null, liveStatePrepared: false };
        } catch (error) {
          // Do not wrap original errors: some browser libraries echo input values.
          throw new RunnerError('UI_RUNNER_BROWSER_LOGIN_FAILED');
        } finally {
          if (credentials) { credentials.username = ''; credentials.password = ''; }
        }
      }
    };
  }
  insist(profile.preparationMode === undefined || profile.preparationMode === 'REQUIRE_ADAPTER', 'UI_RUNNER_PREPARATION_MODE_INVALID');
  const local = config.preparations?.[profile.preparationKey];
  insist(local && typeof local === 'object', 'UI_RUNNER_PREPARATION_NOT_CONFIGURED');
  insist(Array.isArray(local.allowedOrigins) && local.allowedOrigins.length && local.allowedOrigins.every(x => validOrigin(x)), 'UI_RUNNER_PREPARATION_ORIGINS_INVALID');
  insist(profile.allowedOrigins.every(o => local.allowedOrigins.includes(o)), 'UI_RUNNER_PREPARATION_ORIGIN_MISMATCH');
  insist(mode !== 'UI_LIVE' || local.liveAllowed === true, 'UI_RUNNER_LIVE_NOT_CONFIGURED');
  const modulePath = await localPath(config, local.module);
  insist(['.mjs', '.js', '.cjs'].includes(extname(modulePath)), 'UI_RUNNER_PREPARATION_MODULE_INVALID');
  const module = await import(pathToFileURL(modulePath).href);
  const prepare = module.prepare ?? module.default?.prepare;
  insist(typeof prepare === 'function', 'UI_RUNNER_PREPARATION_EXPORT_INVALID');
  const storageState = local.storageStateFile ? await localPath(config, local.storageStateFile) : undefined;
  return { storageState, async run(args) {
    const result = await abortable(Promise.resolve(prepare({ ...args, mode })), args.signal);
    insist(result?.ready === true && result?.baselineReady === true, 'UI_RUNNER_PREPARATION_NOT_READY');
    insist(result.verifiedTargetBuildRef === args.targetBuildRef, 'UI_RUNNER_TARGET_BUILD_UNVERIFIED');
    insist(mode !== 'UI_LIVE' || result.liveStatePrepared === true, 'UI_RUNNER_LIVE_STATE_NOT_PREPARED');
    return { ready: true, baselineReady: true, verifiedTargetBuildRef: result.verifiedTargetBuildRef, liveStatePrepared: mode === 'UI_LIVE' };
  } };
}

export function validateProfile(profile, scope) {
  insist(profile && same(profile.scope, scope), 'UI_RUNNER_PROFILE_SCOPE_MISMATCH');
  insist(profile.preparationMode === undefined || ['REQUIRE_ADAPTER', 'UNAUTHENTICATED', 'BROWSER_AUTH'].includes(profile.preparationMode), 'UI_RUNNER_PREPARATION_MODE_INVALID');
  insist(typeof profile.preparationKey === 'string' && profile.preparationKey.length > 0, 'UI_RUNNER_PREPARATION_NOT_CONFIGURED');
  insist(Number.isSafeInteger(profile.viewport?.width) && Number.isSafeInteger(profile.viewport?.height) && profile.viewport.width > 0 && profile.viewport.height > 0, 'UI_RUNNER_VIEWPORT_INVALID');
  insist(typeof profile.deviceScaleFactor === 'number' && profile.deviceScaleFactor > 0 && profile.deviceScaleFactor <= 8, 'UI_RUNNER_DEVICE_SCALE_INVALID');
  insist(typeof profile.locale === 'string' && typeof profile.timezoneId === 'string', 'UI_RUNNER_RENDER_PROFILE_INVALID');
  insist(Number.isSafeInteger(profile.stepTimeoutMs) && profile.stepTimeoutMs >= 1000 && profile.stepTimeoutMs <= 120000 && Number.isSafeInteger(profile.modeTimeoutMs) && profile.modeTimeoutMs >= profile.stepTimeoutMs && profile.modeTimeoutMs <= 3600000, 'UI_RUNNER_TIME_BUDGET_INVALID');
  return profile;
}
