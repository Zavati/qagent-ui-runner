import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { VERSION, MODES, RunnerError, insist, codeOf, sorted, OriginBinding, checkAbort, abortable } from './core.js';
import { validateSource, ArtifactStore } from './source.js';
import { Ledger } from './ledger.js';
import { CoverageAccounting } from './accounting.js';
import { CheckpointComparator, exactLocator } from './compare.js';
import { NetworkController } from './network.js';
import { contextOf } from './matcher.js';
import { resolvePreparation, validateProfile } from './preparation.js';

export async function performAction(page, action, store, profile, binding, accounting) {
  const type = action.type, timeout = profile.stepTimeoutMs;
  insist(['NAVIGATE', 'CLICK', 'FILL', 'SELECT', 'CHECK', 'SCROLL'].includes(type), 'UI_RUNNER_ACTION_UNSUPPORTED');
  if (type === 'NAVIGATE') { await page.goto(binding.toTarget(action.destination), { waitUntil: 'domcontentloaded', timeout }); return; }
  let target;
  if (type !== 'SCROLL' || action.scrollTarget !== null) {
    insist(action.target?.observedMatchCount === 1 && Array.isArray(action.target?.framePath) && !action.target.framePath.length, 'UI_RUNNER_ACTION_LOCATOR_UNSUPPORTED');
    target = await exactLocator(page, action.target.primaryLocator, timeout);
  }
  if (type === 'CLICK') { insist(action.clickCount === null || [1, 2].includes(action.clickCount), 'UI_RUNNER_CLICK_COUNT_UNSUPPORTED'); await target.click({ timeout, clickCount: action.clickCount ?? 1 }); }
  if (type === 'FILL' || type === 'SELECT') {
    insist(action.inputValueRef, 'UI_RUNNER_ACTION_VALUE_MISSING');
    const value = await store.json(action.inputValueRef, 'ACTION_VALUE_JSON');
    insist(typeof value.value === 'string' && value.value !== '[REDACTED]', 'UI_RUNNER_ACTION_VALUE_UNAVAILABLE');
    if (type === 'FILL') await target.fill(value.value, { timeout }); else await target.selectOption({ value: value.value }, { timeout });
    accounting.used(action.inputValueRef, '/value');
  }
  if (type === 'CHECK') { insist(typeof action.checked === 'boolean', 'UI_RUNNER_ACTION_VALUE_MISSING'); await target.setChecked(action.checked, { timeout }); }
  if (type === 'SCROLL') {
    const p = action.position ?? {}, x = p.scrollX ?? p.x, y = p.scrollY ?? p.y;
    insist(Number.isFinite(x) && Number.isFinite(y), 'UI_RUNNER_SCROLL_POSITION_MISSING');
    if (target) await target.evaluate((el, xy) => el.scrollTo({ left: xy.x, top: xy.y, behavior: 'instant' }), { x, y });
    else await page.evaluate(xy => window.scrollTo({ left: xy.x, top: xy.y, behavior: 'instant' }), { x, y });
  }
}
function initialCounts(spec) { return { actionsPlanned: spec.coverage.actionsTotal, actionsExecuted: 0, checkpointsPlanned: spec.coverage.checkpointsTotal, checkpointsReached: 0, checksPassed: 0, checksFailed: 0, checksPending: 0, fixturesConsumed: 0, requestsObserved: 0 }; }
function configurationReasons(spec, mode) {
  // These requirements are met by this runner plus trusted local preparation and pinned profile.
  const satisfiable = new Set(['UI_TEST_DESIGN_TARGET_BUILD_REQUIRED', 'UI_TEST_DESIGN_RENDER_PROFILE_REQUIRED', 'UI_TEST_DESIGN_RUNNER_REQUIRED', 'UI_BOOTSTRAP_UNAVAILABLE', 'UI_TEST_DESIGN_STATE_TRANSITIONS_UNPROVEN']);
  return spec.readiness[mode].reasonCodes.filter(c => !satisfiable.has(c));
}
export async function launchBrowserSafely(launcher, options, signal) {
  const launched = Promise.resolve().then(() => launcher(options)).catch(error => { throw signal?.aborted ? signal.reason : new RunnerError('UI_RUNNER_BROWSER_LAUNCH_FAILED', {}, { cause: error }); }).then(async browser => {
    if (signal?.aborted) { await browser.close().catch(() => {}); throw signal.reason; }
    return browser;
  });
  return abortable(launched, signal);
}
/** Preparation has an explicit boundary: it does not consume fixtures or inflate execution counts. */
async function prepareContext(context, preparation, binding, args) {
  let violation = null;
  const guard = async route => {
    try {
      const request = route.request(); insist(binding.permits(request.url()), 'UI_RUNNER_PREPARATION_ORIGIN_NOT_ALLOWED');
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: args.profile.stepTimeoutMs });
      try {
        const location = response.headers().location;
        insist(!location || response.status() < 300 || response.status() >= 400 || binding.permits(new URL(location, request.url()).href), 'UI_RUNNER_PREPARATION_REDIRECT_NOT_ALLOWED');
        await route.fulfill({ response });
      } finally { await response.dispose(); }
    } catch (e) { violation = e; await route.abort('blockedbyclient').catch(() => {}); }
  };
  await context.route('**/*', guard);
  await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'Preparation transport unsupported' }));
  const page = await context.newPage();
  try { await preparation.run({ ...args, context, page }); if (violation) throw violation; }
  finally { await page.close().catch(() => {}); await context.unroute('**/*', guard); }
}
export class UiRunner {
  constructor({ preparations = { preparations: {}, directory: process.cwd() }, outputDirectory, browserLauncher, executablePath, onEvidence } = {}) {
    Object.assign(this, { preparations, outputDirectory: outputDirectory ?? 'qagent-results', browserLauncher: browserLauncher ?? (args => chromium.launch(args)), executablePath, onEvidence });
  }
  async runPair({ claim, sourceResponse, readArtifact, signal }) {
    this.modeProgress = null;
    const startedAt = new Date().toISOString();
    const { spec, envelope } = validateSource(claim.design.compilation, sourceResponse, claim.scope);
    const profile = validateProfile(claim.profile, claim.scope), binding = new OriginBinding(profile, spec.entryUrl);
    insist(typeof claim.targetBuildRef === 'string' && claim.targetBuildRef.length > 0, 'UI_RUNNER_TARGET_BUILD_REQUIRED');
    await mkdir(this.outputDirectory, { recursive: true });
    const store = await ArtifactStore.create(envelope.bundle.artifacts, readArtifact, { signal });
    const modes = [], evidence = [];
    try {
      // Hash verification happens before either browser can use a fixture or checkpoint.
      await store.verifyAll();
      for (const mode of MODES) {
        const result = await this.runMode({ claim, mode, spec, envelope, profile, binding, store, signal });
        modes.push(result.mode); evidence.push(...result.evidence);
      }
    } catch (error) {
      if (this.modeProgress?.executionPerformed || modes.length) {
        const fallback = await technicalPair(claim, codeOf(error), this.outputDirectory);
        for (const mode of MODES) {
          if (modes.some(m => m.mode === mode)) continue;
          const row = fallback.modes.find(m => m.mode === mode);
          if (this.modeProgress?.mode === mode) {
            row.executionPerformed = this.modeProgress.executionPerformed;
            row.counts.actionsExecuted = this.modeProgress.counts.actionsExecuted;
            row.counts.checkpointsReached = this.modeProgress.counts.checkpointsReached;
          }
          modes.push(row); evidence.push(...fallback.evidence.filter(e => e.mode === mode));
        }
      } else throw error;
    } finally { await store.dispose(); }
    return { contractVersion: 'qagent.ui-execution-pair-result.v1', runnerVersion: VERSION, startedAt, completedAt: new Date().toISOString(), executionPerformed: modes.some(m => m.executionPerformed), modes, evidence };
  }
  async runMode({ claim, mode, spec, envelope, profile, binding, store, signal }) {
    // Persist reports locally before transport. Evidence upload failure cannot erase executed results.
    const ledger = new Ledger(mode, this.outputDirectory);
    const accounting = new CoverageAccounting(envelope, store, ledger), counts = initialCounts(spec);
    this.modeProgress = { mode, executionPerformed: false, counts };
    const controller = new AbortController(), modeSignal = controller.signal;
    const onAbort = () => controller.abort(signal.reason ?? new RunnerError('UI_RUNNER_CANCELLED'));
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new RunnerError('UI_RUNNER_MODE_TIMEOUT')), profile.modeTimeoutMs); timer.unref?.();
    let browser, context, page, network, executionPerformed = false, status = 'INCOMPLETE', caught = null, tracePath;
    const closeOnAbort = () => { void context?.close().catch(() => {}); };
    modeSignal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      checkAbort(modeSignal);
      const blocks = configurationReasons(spec, mode);
      if (spec.readiness[mode].status === 'BLOCKED' || blocks.length) {
        status = 'BLOCKED'; for (const reason of blocks.length ? blocks : ['UI_RUNNER_IMMUTABLE_DESIGN_BLOCKED']) await ledger.pending(null, reason);
      } else if (mode === 'UI_REPLAY' && envelope.bundle.fixtures.some(f => f.availability !== 'READY')) {
        status = 'BLOCKED'; await ledger.pending(null, 'UI_TEST_DESIGN_REPLAY_FIXTURES_UNAVAILABLE');
      } else {
        const preparation = await resolvePreparation(this.preparations, profile, mode);
        browser = await launchBrowserSafely(this.browserLauncher, { headless: true, ...(this.executablePath ? { executablePath: this.executablePath } : {}) }, modeSignal);
        context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, locale: profile.locale, timezoneId: profile.timezoneId, serviceWorkers: 'block', acceptDownloads: false, storageState: preparation.storageState });
        context.setDefaultTimeout(profile.stepTimeoutMs); context.setDefaultNavigationTimeout(profile.stepTimeoutMs);
        await prepareContext(context, preparation, binding, { profile, targetBuildRef: claim.targetBuildRef, signal: modeSignal });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        network = await NetworkController.create({ mode, envelope, store, ledger, profile, binding, accounting, signal: modeSignal });
        await network.install(context);
        page = await context.newPage();
        context.on('page', other => { if (other !== page) { void ledger.pending(null, 'UI_RUNNER_POPUP_UNSUPPORTED'); void other.close().catch(() => {}); } });
        const comparator = new CheckpointComparator({ page, store, ledger, mode, profile, spec, binding, accounting, signal: modeSignal });
        const actions = [...envelope.journey.actions].sort((a, b) => a.observedSequence - b.observedSequence);
        const states = new Map(envelope.pageIndex.states.map((s, i) => [s.stateId, { state: s, index: i }]));
        const compared = new Set();
        const checkpoint = async id => {
          if (!id || compared.has(id)) return;
          const entry = states.get(id); insist(entry, 'UI_RUNNER_CHECKPOINT_REFERENCE_INVALID');
          const stableNetwork = await network.settle();
          if (!stableNetwork) { await ledger.pending({ pointer: '/pageIndex/states/' + entry.index, manifestHash: spec.source.manifestHash }, 'UI_RUNNER_CHECKPOINT_NETWORK_INFLIGHT'); compared.add(id); return; }
          if (await comparator.run(entry.state, entry.index)) { counts.checkpointsReached++; accounting.states.add(id); }
          compared.add(id);
        };
        // Explicit bootstrap only when the observed first action is not the initial navigation.
        if (!actions.length || actions[0].type !== 'NAVIGATE') {
          network.context = actions[0] ?? envelope.pageIndex.states[0] ?? {};
          executionPerformed = true; this.modeProgress.executionPerformed = true;
          await page.goto(binding.toTarget(spec.entryUrl), { waitUntil: 'domcontentloaded', timeout: profile.stepTimeoutMs });
          executionPerformed = true;
        }
        for (const action of actions) {
          checkAbort(modeSignal);
          network.context = contextOf(action);
          await checkpoint(action.stateBeforeId);
          const i = envelope.journey.actions.indexOf(action), ref = { pointer: '/journey/actions/' + i, manifestHash: envelope.manifestHash };
          try {
            executionPerformed = true;
            this.modeProgress.executionPerformed = true;
            await abortable(performAction(page, action, store, profile, binding, accounting), modeSignal);
            executionPerformed = true; counts.actionsExecuted++; accounting.actions.add(action.actionId);
            await ledger.check('ACTION_EXECUTED', 'PASSED', ref, { type: action.type }, { type: action.type });
          } catch (error) {
            if (modeSignal.aborted) throw modeSignal.reason;
            await ledger.check('ACTION_EXECUTED', 'FAILED', ref, { type: action.type }, null, codeOf(error, error?.name === 'TimeoutError' ? 'UI_RUNNER_STEP_TIMEOUT' : 'UI_RUNNER_ACTION_FAILED'));
            // Later actions cannot safely be relabelled onto a different application state.
            break;
          }
          await network.settle();
          if (action.stateAfterId) await checkpoint(action.stateAfterId);
          else await ledger.pending(ref, 'UI_RUNNER_ACTION_STATE_LINK_UNAVAILABLE');
        }
        await network.settle();
        await ledger.attachment('FINAL_SCREENSHOT', await page.screenshot({ fullPage: true, timeout: profile.stepTimeoutMs }), 'image/png', '.png');
      }
    } catch (error) {
      caught = modeSignal.aborted ? modeSignal.reason : error;
      const code = codeOf(caught, caught?.name === 'TimeoutError' ? 'UI_RUNNER_STEP_TIMEOUT' : 'UI_RUNNER_TECHNICAL_ERROR');
      status = code === 'UI_RUNNER_CANCELLED' ? 'CANCELLED' : code.startsWith('UI_RUNNER_PREPARATION_') || ['UI_RUNNER_LIVE_NOT_CONFIGURED', 'UI_RUNNER_TARGET_BUILD_UNVERIFIED', 'UI_RUNNER_LIVE_STATE_NOT_PREPARED'].includes(code) ? 'BLOCKED' : 'ERROR';
      await ledger.pending(null, code);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); modeSignal.removeEventListener('abort', closeOnAbort);
      if (context) {
        tracePath = join(this.outputDirectory, 'trace-' + mode + '.zip');
        try { await context.tracing.stop({ path: tracePath }); const bytes = await readFile(tracePath); await ledger.attachment('PLAYWRIGHT_TRACE', bytes, 'application/zip', '.zip'); }
        catch { await ledger.pending(null, 'UI_RUNNER_TRACE_UNAVAILABLE'); }
        await context.close().catch(() => {});
      }
      await browser?.close().catch(() => {});
      if (network) { await network.finish(); counts.fixturesConsumed = network.matcher.consumed; }
      // Run accounting even on blocked/cancelled paths: nothing disappears from the plan.
      await accounting.finish();
    }
    counts.checksPassed = ledger.statuses.PASSED; counts.checksFailed = ledger.statuses.FAILED; counts.checksPending = ledger.statuses.PENDING; counts.requestsObserved = ledger.lengths.network;
    if (!caught && !['BLOCKED', 'CANCELLED'].includes(status)) status = counts.checksFailed ? 'FAILED' : counts.checksPending || ledger.lengths.pending || counts.actionsExecuted !== counts.actionsPlanned || counts.checkpointsReached !== counts.checkpointsPlanned || !executionPerformed || !counts.checksPassed ? 'INCOMPLETE' : 'PASSED';
    const reports = await ledger.finish();
    return { mode: { mode, status, reasonCodes: sorted(ledger.reasons), executionPerformed, counts, ...reports }, evidence: ledger.evidence };
  }
}

export async function technicalPair(claim, code, directory, onEvidence, { cancelled = false } = {}) {
  const startedAt = new Date().toISOString(), modes = [], evidence = [], spec = claim.design.compilation.specification;
  for (const mode of MODES) {
    const ledger = new Ledger(mode, directory, { onEvidence }); await ledger.pending(null, code);
    const counts = initialCounts(spec); counts.checksPending = 1;
    modes.push({ mode, status: cancelled ? 'CANCELLED' : 'ERROR', reasonCodes: [code], executionPerformed: false, counts, ...await ledger.finish() }); evidence.push(...ledger.evidence);
  }
  return { contractVersion: 'qagent.ui-execution-pair-result.v1', runnerVersion: VERSION, startedAt, completedAt: new Date().toISOString(), executionPerformed: false, modes, evidence };
}
