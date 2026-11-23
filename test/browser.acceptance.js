/** Real Chromium acceptance. It deliberately fails when the browser cannot launch; never a fake PASS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UiRunner } from '../src/engine.js';
import { readCollection } from '../src/ledger.js';
import { fixture } from './fixture.js';

test('Chromium: strict Replay uses observed body; fresh Live invokes current backend and reports change', { timeout: 60000 }, async () => {
  let liveRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/api/items')) { liveRequests++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ title: 'Live item changed' })); return; }
    if (request.url === '/items') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><main data-testid="main"><h1 data-testid="heading">Loading</h1><input data-testid="query"><button data-testid="save">Save</button></main><script>fetch('/api/items?tag=one&tag=two').then(r=>r.json()).then(d=>document.querySelector('h1').textContent=d.title);</script>`); return;
    }
    response.statusCode = 404; response.end('missing');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const directory = await mkdtemp(join(tmpdir(), 'qagent-real-browser-'));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port, f = fixture({ origin });
    await writeFile(join(directory, 'prepare.mjs'), `export async function prepare({context,targetBuildRef,mode}) { const cookies=await context.cookies(); if(cookies.length) throw new Error('context was reused'); await context.addCookies([{name:'qagent_mode',value:mode,url:${JSON.stringify(origin)}}]); return {ready:true,baselineReady:true,verifiedTargetBuildRef:targetBuildRef,liveStatePrepared:mode==='UI_LIVE'}; }`);
    const runner = new UiRunner({ outputDirectory: directory, executablePath: process.env.QAGENT_CHROMIUM_EXECUTABLE, preparations: { directory, preparations: { sample: { module: './prepare.mjs', liveAllowed: true, allowedOrigins: [origin] } } } });
    const result = await runner.runPair({ claim: f.claim, sourceResponse: f.response, readArtifact: async id => f.bytes.get(id) });
    assert.equal(result.modes[0].executionPerformed, true, JSON.stringify(result.modes[0].reasonCodes));
    assert.equal(result.modes[1].executionPerformed, true, JSON.stringify(result.modes[1].reasonCodes));
    assert.equal(liveRequests, 1, 'Replay must not call backend; fresh Live must call once');
    assert.equal(result.modes[0].counts.actionsExecuted, 2); assert.equal(result.modes[1].counts.actionsExecuted, 2);
    const replay = await readCollection(result.modes[0], 'checks', directory), live = await readCollection(result.modes[1], 'checks', directory);
    assert.ok(replay.some(c => c.kind === 'DIRECT_TEXT_EQUALS' && c.status === 'PASSED' && c.expected === 'Observed item'));
    assert.ok(live.some(c => c.kind === 'DIRECT_TEXT_EQUALS' && c.status === 'PENDING' && c.reasonCode === 'UI_RUNNER_LIVE_OBSERVED_DATA_CHANGED'));
    const replayNetwork = await readCollection(result.modes[0], 'network', directory), liveNetwork = await readCollection(result.modes[1], 'network', directory);
    assert.equal(replayNetwork.filter(n => n.business && n.replayed).length, 1); assert.equal(liveNetwork.filter(n => n.business && n.replayed).length, 0);
    assert.ok(result.modes.every(m => m.status === 'INCOMPLETE'), 'unsupported metadata stays pending; browser completion is not full coverage');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
