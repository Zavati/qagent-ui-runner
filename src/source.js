import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateUiObservedPlanShape } from './observed-plan-contract.js';
import { insist, digest, sha256, same, checkAbort, RunnerError, getPointer } from './core.js';
import { parseStrictJson } from './strict-json.js';

export function validateSource(compilation, response, scope) {
  insist(compilation?.outcome === 'COMPILED' && compilation.contractVersion === 'qagent.ui-test-design-compilation.v2', 'UI_RUNNER_DESIGN_VERSION_UNSUPPORTED');
  const spec = validateUiObservedPlanShape(compilation.specification);
  insist(digest(spec) === compilation.specificationHash, 'UI_RUNNER_SPECIFICATION_HASH_MISMATCH');
  insist(same(scope, spec.scope) && same(compilation.source, spec.source), 'UI_RUNNER_SCOPE_MISMATCH');
  insist(response?.contractVersion === 'qagent.ui-execution-source.v1' && response.specificationHash === compilation.specificationHash, 'UI_RUNNER_SOURCE_INVALID');
  insist(same(response.source, spec.source), 'UI_RUNNER_SOURCE_PIN_MISMATCH');
  const e = response.envelope;
  insist(e && e.contractVersion === 'qagent.ui-page-evidence.v2' && e.manifestState === 'SEALED' && e.qualification?.dimensions?.integrity?.status === 'READY', 'UI_RUNNER_MANIFEST_NOT_READY');
  const { manifestHash, ...content } = e;
  insist(manifestHash === spec.source.manifestHash && digest(content) === manifestHash, 'UI_RUNNER_MANIFEST_HASH_MISMATCH');
  insist(e.bundleVersionId === spec.source.bundleVersionId && e.source?.captureId === spec.source.captureId && e.source?.sourceHash === spec.source.sourceHash && same(e.source.scope, scope), 'UI_RUNNER_ENVELOPE_CONTEXT_MISMATCH');
  for (const section of spec.plan.sections) {
    if (!section.pointer) continue;
    const rows = getPointer(e, section.pointer);
    insist(Array.isArray(rows) && rows.length === section.count, 'UI_RUNNER_PLAN_SOURCE_COUNT_MISMATCH', { section: section.section });
  }
  insist(e.journey.entryUrl === spec.entryUrl, 'UI_RUNNER_ENTRY_URL_MISMATCH');
  insist(e.bundle.applicationResources?.archiveExecutionAllowed !== true, 'UI_RUNNER_ARCHIVE_EXECUTION_FORBIDDEN');
  return { spec, envelope: e };
}

/** Disk-backed immutable artifacts: bounded individual reads, no aggregate journey byte ceiling. */
export class ArtifactStore {
  static async create(refs, reader, { signal, maxArtifactBytes = 32 * 1024 * 1024, directory } = {}) {
    const dir = await mkdtemp(join(directory ?? tmpdir(), 'qagent-ui-artifacts-'));
    return new ArtifactStore(refs, reader, { signal, maxArtifactBytes, dir });
  }
  constructor(refs, reader, options) {
    this.reader = reader; Object.assign(this, options); this.refs = new Map(); this.files = new Map(); this.inflight = new Map();
    for (const r of refs) {
      insist(typeof r.artifactId === 'string' && /^[A-Za-z0-9_-]{3,180}$/.test(r.artifactId) && !this.refs.has(r.artifactId), 'UI_RUNNER_ARTIFACT_DECLARATION_INVALID');
      insist(/^[a-f0-9]{64}$/.test(r.sha256) && Number.isSafeInteger(r.byteLength) && r.byteLength > 0, 'UI_RUNNER_ARTIFACT_DECLARATION_INVALID');
      this.refs.set(r.artifactId, r);
    }
  }
  declaration(id, expectedKind) {
    const ref = this.refs.get(id);
    insist(ref && (!expectedKind || ref.kind === expectedKind), 'UI_RUNNER_ARTIFACT_NOT_DECLARED', { artifactId: id });
    return ref;
  }
  async ensure(id) {
    checkAbort(this.signal); const ref = this.declaration(id);
    if (this.files.has(id)) return this.files.get(id);
    if (this.inflight.has(id)) return this.inflight.get(id);
    const pending = (async () => {
      insist(ref.byteLength <= this.maxArtifactBytes, 'UI_RUNNER_ARTIFACT_READ_LIMIT', { artifactId: id, byteLength: ref.byteLength });
      const bytes = Buffer.from(await this.reader(id, { signal: this.signal, maxBytes: ref.byteLength }));
      checkAbort(this.signal);
      insist(bytes.length === ref.byteLength && sha256(bytes) === ref.sha256, 'UI_RUNNER_ARTIFACT_HASH_MISMATCH', { artifactId: id });
      const path = join(this.dir, id); await writeFile(path, bytes, { mode: 0o600 }); this.files.set(id, path); return path;
    })();
    this.inflight.set(id, pending);
    try { return await pending; } finally { this.inflight.delete(id); }
  }
  async bytes(id) { return readFile(await this.ensure(id)); }
  async json(id, kind) {
    this.declaration(id, kind);
    const bytes = await this.bytes(id);
    try { return parseStrictJson(bytes); }
    catch (e) { throw new RunnerError('UI_RUNNER_ARTIFACT_JSON_INVALID', { artifactId: id }, { cause: e }); }
  }
  ref(id, pointer = '') { const r = this.declaration(id); return { artifactId: id, sha256: r.sha256, byteLength: r.byteLength, pointer }; }
  async verifyAll() { for (const id of this.refs.keys()) await this.ensure(id); }
  async dispose() { await Promise.allSettled(this.inflight.values()); await rm(this.dir, { recursive: true, force: true }); }
}
