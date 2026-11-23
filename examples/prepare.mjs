/** Trusted local adapter. Replace the build probe/reset endpoints with YOUR staging application. */
export async function prepare({ context, mode, profile, targetBuildRef, signal }) {
  const base = new URL(profile.targetBaseUrl);
  // These calls are explicit setup, before observed request matching starts.
  const build = await context.request.get(new URL('/__test/build', base).href, { timeout: profile.stepTimeoutMs, maxRedirects: 0 });
  if (!build.ok()) throw new Error('Application build probe is not configured');
  const metadata = await build.json(); await build.dispose();
  if (metadata.buildRef !== targetBuildRef) throw new Error('Target build does not match the batch');
  if (signal.aborted) throw signal.reason;
  // Test state must be prepared separately for each mode. Use an isolated tenant/seed per item.
  const reset = await context.request.post(new URL('/__test/prepare-ui', base).href, {
    timeout: profile.stepTimeoutMs, maxRedirects: 0,
    headers: { 'X-Test-Preparation-Token': process.env.QAGENT_TEST_PREPARATION_TOKEN ?? '' },
    data: { mode, fixtureSet: 'qa-approved-baseline' }
  });
  if (!reset.ok()) throw new Error('UI baseline preparation failed');
  const state = await reset.json(); await reset.dispose();
  if (state.storageState) {
    // Cookies stay in the browser context; they are not returned through the execution API.
    if (state.storageState.cookies) await context.addCookies(state.storageState.cookies);
    if (state.storageState.origins?.length) throw new Error('Use a trusted local storageStateFile for localStorage authentication');
  }
  if (state.baselineReady !== true) throw new Error('Baseline state not confirmed');
  return { ready: true, baselineReady: true, verifiedTargetBuildRef: metadata.buildRef, liveStatePrepared: mode === 'UI_LIVE' };
}
