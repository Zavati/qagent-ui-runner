import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { UiRunner, technicalPair } from './engine.js';
import { RunnerError, codeOf, checkAbort, sleep } from './core.js';
import { writePairReports, batchExitCode } from './reports.js';
import { EvidencePublisher } from './evidence-publisher.js';

export class Worker {
  constructor({ client, preparations, directory = 'qagent-results', workerId = 'uiworker_' + randomUUID(), executablePath, heartbeatMs = 20000, engineFactory, log = entry => process.stdout.write(JSON.stringify(entry) + '\n') }) {
    Object.assign(this, { client, preparations, directory, workerId, executablePath, heartbeatMs, log }); this.engineFactory = engineFactory ?? (options => new UiRunner(options));
  }
  async executeClaim(claim, parentSignal) {
    const directory = join(this.directory, claim.batchId, claim.itemId); await mkdir(directory, { recursive: true });
    const controller = new AbortController(); let leaseExpiresAt = Number(claim.leaseExpiresAt), heartbeating = null, heartbeatStopped = false;
    const parentAbort = () => controller.abort(parentSignal.reason ?? new RunnerError('UI_RUNNER_CANCELLED'));
    parentSignal?.addEventListener('abort', parentAbort, { once: true }); if (parentSignal?.aborted) parentAbort();
    const stopHeartbeat = () => { heartbeatStopped = true; clearInterval(heartbeat); };
    const heart = () => {
      if (heartbeating || heartbeatStopped) return heartbeating;
      heartbeating = Promise.resolve().then(async () => {
        try { const state = await this.client.heartbeat(claim); leaseExpiresAt = state.leaseExpiresAt; if (state.cancelRequested) controller.abort(new RunnerError('UI_RUNNER_CANCELLED')); }
        catch (e) {
          if (e.details?.httpStatus >= 400 && e.details?.httpStatus < 500 || Date.now() >= leaseExpiresAt) {
            // A result commit can win the race with this renewal. A terminal
            // claim must not keep producing rejected heartbeats while its ACK
            // is in flight. The canonical result request remains authoritative.
            stopHeartbeat(); controller.abort(new RunnerError('UI_RUNNER_LEASE_LOST'));
          }
        } finally { heartbeating = null; }
      });
      return heartbeating;
    };
    const heartbeat = setInterval(() => {
      if (Date.now() >= leaseExpiresAt) { stopHeartbeat(); controller.abort(new RunnerError('UI_RUNNER_LEASE_LOST')); return; }
      void heart();
    }, this.heartbeatMs); heartbeat.unref?.();
    let pair;
    const publisher = new EvidencePublisher(this.client, claim, { log: this.log });
    const onEvidence = (ref, bytes, path) => publisher.enqueue(ref, bytes, path);
    try {
      try {
        this.log({ event: 'ui.execution.started', batchId: claim.batchId, itemId: claim.itemId });
        const sourceResponse = await this.client.source(claim, controller.signal);
        const engine = this.engineFactory({ preparations: this.preparations, outputDirectory: directory, executablePath: this.executablePath, onEvidence });
        pair = await engine.runPair({ claim, sourceResponse, readArtifact: (id, options) => this.client.artifact(claim, id, options), signal: controller.signal });
      } catch (error) {
        const code = codeOf(controller.signal.aborted ? controller.signal.reason : error);
        // Technical finalization does not rerun a browser; a failed transport never replays Live.
        pair = await technicalPair(claim, code, directory, onEvidence, { cancelled: code === 'UI_RUNNER_CANCELLED' });
      }
      await writePairReports(directory, pair, claim.design.testDesignVersionId);
      const files = await readdir(directory);
      for (const ref of pair.evidence) {
        const file = files.find(name => name.startsWith(ref.evidenceId + '.'));
        if (!file) throw new RunnerError('UI_RUNNER_LOCAL_EVIDENCE_MISSING');
        publisher.enqueue(ref, null, join(directory, file));
      }
      await publisher.drain();
      const result = await this.client.result(claim, pair);
      this.log({ event: 'ui.execution.completed', batchId: claim.batchId, itemId: claim.itemId, modes: pair.modes.map(m => ({ mode: m.mode, status: m.status, counts: m.counts })) });
      return result;
    } finally {
      try { await publisher.settle(); }
      finally {
        stopHeartbeat();
        // Join the one renewal already in flight so no request outlives this
        // claim's lifecycle. Renewals remain active during result validation.
        try { await heartbeating; }
        finally { parentSignal?.removeEventListener('abort', parentAbort); }
      }
    }
  }
  async runBatch(batchId, { signal, pollMs = 1500 } = {}) {
    while (true) {
      checkAbort(signal);
      const { claim } = await this.client.claim(batchId, this.workerId);
      if (claim) { await this.executeClaim(claim, signal); continue; }
      const batch = await this.client.batch(batchId);
      if (['COMPLETED', 'CANCELLED'].includes(batch.status)) {
        const directory = join(this.directory, batchId); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'batch.json'), JSON.stringify(batch, null, 2) + '\n', { mode: 0o600 });
        for (const format of ['json', 'junit']) {
          const report = await this.client.report(batchId, format); await writeFile(join(directory, format === 'json' ? 'report.json' : 'junit.xml'), report, { mode: 0o600 });
        }
        return { batch, exitCode: batchExitCode(batch) };
      }
      await sleep(pollMs, signal);
    }
  }
  async serve({ signal, once = false, pollMs = 5000 } = {}) {
    while (true) {
      checkAbort(signal); let cursor = null, worked = false; const seen = new Set();
      do {
        const page = await this.client.batches(cursor);
        for (const batch of page.items) if (['QUEUED', 'RUNNING'].includes(batch.status)) {
          const { claim } = await this.client.claim(batch.batchId, this.workerId);
          if (claim) { await this.executeClaim(claim, signal); worked = true; if (once) return; }
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new RunnerError('UI_RUNNER_PAGINATION_LOOP'); if (cursor) seen.add(cursor);
      } while (cursor);
      if (once) return;
      await sleep(worked ? 50 : pollMs, signal);
    }
  }
}
