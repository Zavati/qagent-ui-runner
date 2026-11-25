import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreparation } from '../src/preparation.js';

const config = { preparations: {} };
const profile = {
  preparationMode: 'BROWSER_AUTH', targetBaseUrl: 'https://example.test/',
  browserAuth: { authProfileId: 'authp_123', config: {
    loginPath: '/login', usernameSelector: '#username', passwordSelector: '#password',
    submitSelector: '#submit', successSelector: '#signed-in',
  } },
  stepTimeoutMs: 7000,
};
test('UI_LOGIN prepares a fresh page and resolves credentials at execution time, without emitting values', async () => {
  const actions = [];
  let secret = { username: 'private.username', password: 'secret.password' };
  const page = {
    async goto(url) { actions.push(['goto', url]); },
    locator(selector) { return {
      async fill(value) { actions.push(['fill', selector, value === 'private.username' ? 'username' : 'password']); },
      async click() { actions.push(['click', selector]); },
      async waitFor() { actions.push(['visible', selector]); },
    }; },
  };
  const preparation = await resolvePreparation(config, profile, 'UI_LIVE');
  const result = await preparation.run({ page, claim: { itemId: 'i' }, authProvider: async () => secret });
  assert.equal(result.ready, true);
  assert.equal(result.baselineReady, false);
  assert.equal(secret.username, '');
  assert.equal(secret.password, '');
  assert.deepEqual(actions, [
    ['goto','https://example.test/login'], ['fill','#username','username'],
    ['fill','#password','password'], ['click','#submit'], ['visible','#signed-in'],
  ]);
});
test('failed browser authentication returns sanitized code (never raw browser error containing secret)', async () => {
  const preparation = await resolvePreparation(config, profile, 'UI_REPLAY');
  const page = { async goto() { throw new Error('secret.password'); } };
  await assert.rejects(preparation.run({ page, authProvider: async () => ({ username: 'user', password: 'secret.password' }) }), e => e.code === 'UI_RUNNER_BROWSER_LOGIN_FAILED' && !e.message.includes('password'));
});
test('browser auth rejects cross-origin login path', async () => {
  await assert.rejects(resolvePreparation(config, { ...profile, browserAuth: { ...profile.browserAuth, config: { ...profile.browserAuth.config, loginPath: '//evil.test/' } } }, 'UI_LIVE'), e => e.code === 'UI_RUNNER_BROWSER_AUTH_INVALID');
});
