import { readFile } from 'node:fs/promises';
import { insist, codeOf } from './core.js';

/** Publish persisted files progressively without delaying a browser request on upload I/O.
 * The queue holds file paths, not all binary evidence in memory. Finalization waits
 * for every declared receipt; failure never turns an executed test into a PASS.
 */
export class EvidencePublisher {
  constructor(client, claim, { log = () => {} } = {}) {
    Object.assign(this, { client, claim, log });
    this.entries = new Map(); this.tail = Promise.resolve();
  }
  enqueue(ref, _bytes, path) {
    insist(typeof path === 'string' && path.length > 0, 'UI_RUNNER_LOCAL_EVIDENCE_MISSING');
    const old = this.entries.get(ref.evidenceId);
    if (old) {
      insist(old.ref.sha256 === ref.sha256 && old.ref.byteLength === ref.byteLength, 'UI_RUNNER_EVIDENCE_CONFLICT');
      return;
    }
    const entry = { ref, path, uploaded: false, failure: null, attempts: 0 };
    this.entries.set(ref.evidenceId, entry); this.schedule(entry);
  }
  schedule(entry) {
    this.tail = this.tail.then(async () => {
      if (entry.uploaded) return;
      entry.attempts++;
      try {
        const bytes = await readFile(entry.path);
        await this.client.evidence(this.claim, entry.ref, bytes);
        entry.uploaded = true; entry.failure = null;
      } catch (error) {
        entry.failure = error;
        this.log({ event: 'ui.evidence.upload_pending', batchId: this.claim.batchId, itemId: this.claim.itemId, evidenceId: entry.ref.evidenceId, code: codeOf(error) });
      }
    });
  }
  async drain({ retryFailed = true } = {}) {
    await this.tail;
    if (retryFailed) {
      for (const entry of this.entries.values()) if (!entry.uploaded) this.schedule(entry);
      await this.tail;
    }
    const failed = [...this.entries.values()].find(entry => !entry.uploaded);
    if (failed) throw failed.failure;
  }
  async settle() { await this.tail; }
}
