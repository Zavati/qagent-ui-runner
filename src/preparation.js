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
  insist(profile.preparationMode === undefined || ['REQUIRE_ADAPTER', 'UNAUTHENTICATED'].includes(profile.preparationMode), 'UI_RUNNER_PREPARATION_MODE_INVALID');
  insist(typeof profile.preparationKey === 'string' && profile.preparationKey.length > 0, 'UI_RUNNER_PREPARATION_NOT_CONFIGURED');
  insist(Number.isSafeInteger(profile.viewport?.width) && Number.isSafeInteger(profile.viewport?.height) && profile.viewport.width > 0 && profile.viewport.height > 0, 'UI_RUNNER_VIEWPORT_INVALID');
  insist(typeof profile.deviceScaleFactor === 'number' && profile.deviceScaleFactor > 0 && profile.deviceScaleFactor <= 8, 'UI_RUNNER_DEVICE_SCALE_INVALID');
  insist(typeof profile.locale === 'string' && typeof profile.timezoneId === 'string', 'UI_RUNNER_RENDER_PROFILE_INVALID');
  insist(Number.isSafeInteger(profile.stepTimeoutMs) && profile.stepTimeoutMs >= 1000 && profile.stepTimeoutMs <= 120000 && Number.isSafeInteger(profile.modeTimeoutMs) && profile.modeTimeoutMs >= profile.stepTimeoutMs && profile.modeTimeoutMs <= 3600000, 'UI_RUNNER_TIME_BUDGET_INVALID');
  return profile;
}
