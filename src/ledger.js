import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, insist, summarized } from './core.js';

/** Per-page operational limit, never a cap on the total plan/report. No check sampling. */
export class Ledger {
  constructor(mode, directory, { pageBytes = 256 * 1024, onEvidence, flushIntervalMs = 2000 } = {}) {
    this.mode = mode; this.directory = directory; this.pageBytes = pageBytes; this.onEvidence = onEvidence;
    this.buffers = { checks: [], network: [], pending: [] };
    this.sizes = { checks: 0, network: 0, pending: 0 };
    this.lengths = { checks: 0, network: 0, pending: 0 };
    this.statuses = { PASSED: 0, FAILED: 0, PENDING: 0 };
    this.pages = []; this.evidence = []; this.reasons = new Set(); this.serial = Promise.resolve(); this.next = 0;
    this.namespace = randomUUID().replace(/-/g, '').slice(0, 12);
    this.flushError = null;
    if (onEvidence && flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => { void this.flushPending().catch(error => { this.flushError = error; }); }, flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }
  append(collection, row) {
    const work = async () => {
      insist(Object.hasOwn(this.buffers, collection), 'UI_RUNNER_REPORT_COLLECTION_INVALID');
      const line = JSON.stringify(row) + '\n', length = Buffer.byteLength(line);
      insist(length <= 2 * 1024 * 1024, 'UI_RUNNER_REPORT_ROW_TOO_LARGE');
      if (this.sizes[collection] && this.sizes[collection] + length > this.pageBytes) await this.flush(collection);
      this.buffers[collection].push(line); this.sizes[collection] += length; this.lengths[collection]++;
      if (collection === 'checks') {
        insist(Object.hasOwn(this.statuses, row.status), 'UI_RUNNER_CHECK_STATUS_INVALID'); this.statuses[row.status]++;
      }
      if (row.reasonCode) this.reasons.add(row.reasonCode);
      if (this.sizes[collection] >= this.pageBytes) await this.flush(collection);
    };
    const result = this.serial.then(work); this.serial = result; return result;
  }
  async check(kind, status, sourceRef, expected, actual, reasonCode) {
    const id = 'uick_' + this.mode.toLowerCase() + '_' + this.namespace + '_' + String(++this.next).padStart(9, '0');
    await this.append('checks', { id, kind, status, sourceRef: sourceRef ?? null, expected: summarized(expected), actual: summarized(actual), ...(reasonCode ? { reasonCode } : {}) });
    return id;
  }
  async pending(sourceRef, reasonCode, details = {}) {
    const id = await this.check('OBSERVED_EVIDENCE', 'PENDING', sourceRef, null, null, reasonCode);
    await this.append('pending', { id, sourceRef: sourceRef ?? null, reasonCode, ...details }); return id;
  }
  async flush(collection) {
    if (!this.buffers[collection].length) return;
    const bytes = Buffer.from(this.buffers[collection].join(''));
    const evidenceId = 'uire_' + this.mode.toLowerCase() + '_' + this.namespace + '_' + collection + '_' + String(this.pages.length).padStart(7, '0');
    const ref = { evidenceId, collection, count: this.buffers[collection].length, sha256: sha256(bytes), byteLength: bytes.length, contentType: 'application/x-ndjson' };
    const path = join(this.directory, evidenceId + '.ndjson');
    await mkdir(this.directory, { recursive: true }); await writeFile(path, bytes, { mode: 0o600 });
    this.pages.push(ref); this.evidence.push({ evidenceId, sha256: ref.sha256, byteLength: ref.byteLength, contentType: ref.contentType, mode: this.mode, kind: 'REPORT_PAGE' });
    this.buffers[collection] = []; this.sizes[collection] = 0;
    if (this.onEvidence) await this.onEvidence({ ...ref, mode: this.mode, kind: 'REPORT_PAGE' }, bytes, path);
  }
  flushPending() {
    const work = async () => { for (const collection of Object.keys(this.buffers)) await this.flush(collection); };
    const result = this.serial.then(work); this.serial = result; return result;
  }
  async finish() {
    clearInterval(this.flushTimer);
    await this.flushPending();
    if (this.flushError) throw this.flushError;
    for (const c of Object.keys(this.buffers)) insist(this.pages.filter(p => p.collection === c).reduce((n, p) => n + p.count, 0) === this.lengths[c], 'UI_RUNNER_REPORT_ACCOUNTING_MISMATCH');
    return { checks: [], network: [], pending: [], externalized: true, reportPages: this.pages };
  }
  async attachment(kind, bytes, contentType, extension) {
    // Match the Gateway's persisted media type before building any immutable
    // reference. Response headers commonly include charset parameters; keeping
    // those only in the local ref would make final result reconciliation fail.
    insist(typeof contentType === 'string', 'UI_RUNNER_EVIDENCE_CONTENT_TYPE_INVALID');
    contentType = contentType.split(';', 1)[0].trim().toLowerCase();
    insist(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType), 'UI_RUNNER_EVIDENCE_CONTENT_TYPE_INVALID');
    if (bytes.length > 8 * 1024 * 1024) {
      const parts = [];
      for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024) parts.push(await this.attachment(kind + '_PART', bytes.subarray(offset, Math.min(bytes.length, offset + 8 * 1024 * 1024)), 'application/octet-stream', '.part'));
      const manifest = Buffer.from(JSON.stringify({ contractVersion: 'qagent.ui-execution-binary-parts.v1', contentType, byteLength: bytes.length, sha256: sha256(bytes), parts }));
      return this.attachment(kind + '_MANIFEST', manifest, 'application/json', '.json');
    }
    const evidenceId = 'uire_' + this.mode.toLowerCase() + '_' + kind.toLowerCase() + '_' + sha256(bytes).slice(0, 24);
    const ref = { evidenceId, sha256: sha256(bytes), byteLength: bytes.length, contentType, mode: this.mode, kind };
    const existing = this.evidence.find(e => e.evidenceId === evidenceId);
    if (existing) return existing;
    const path = join(this.directory, evidenceId + extension);
    await mkdir(this.directory, { recursive: true }); await writeFile(path, bytes, { mode: 0o600 });
    this.evidence.push(ref); if (this.onEvidence) await this.onEvidence(ref, bytes, path); return ref;
  }
}

export async function readCollection(modeResult, collection, directory) {
  if (!modeResult.externalized) return modeResult[collection];
  const rows = [];
  for (const p of modeResult.reportPages.filter(p => p.collection === collection)) {
    const b = await readFile(join(directory, p.evidenceId + '.ndjson'));
    insist(b.length === p.byteLength && sha256(b) === p.sha256, 'UI_RUNNER_REPORT_HASH_MISMATCH');
    const lines = b.toString('utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
    insist(lines.length === p.count, 'UI_RUNNER_REPORT_ACCOUNTING_MISMATCH'); rows.push(...lines);
  }
  return rows;
}
