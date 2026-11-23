import { leaves, escapePointer } from './core.js';

/** Reading a hash is integrity verification, not proof that all artifact fields matched the UI. */
export class CoverageAccounting {
  constructor(envelope, store, ledger) { Object.assign(this, { envelope, store, ledger }); this.usedPaths = new Map(); this.states = new Set(); this.actions = new Set(); this.interactions = new Set(); }
  used(id, pointer, subtree = false) { const paths = this.usedPaths.get(id) ?? new Map(); paths.set(pointer, (paths.get(pointer) ?? false) || subtree); this.usedPaths.set(id, paths); }
  isUsed(id, pointer) { return [...(this.usedPaths.get(id) ?? [])].some(([p, subtree]) => pointer === p || (subtree && (p === '' || pointer.startsWith(p + '/')))); }
  async finish() {
    const e = this.envelope, manifest = pointer => ({ manifestHash: e.manifestHash, pointer });
    for (const [i, a] of e.journey.actions.entries()) if (!this.actions.has(a.actionId)) await this.ledger.pending(manifest('/journey/actions/' + i), 'UI_RUNNER_ACTION_NOT_EXECUTED');
    for (const [i, s] of e.pageIndex.states.entries()) if (!this.states.has(s.stateId)) await this.ledger.pending(manifest('/pageIndex/states/' + i), 'UI_RUNNER_CHECKPOINT_NOT_REACHED');
    for (const [i, n] of e.pageIndex.interactions.entries()) if (!this.interactions.has(n.eventId)) await this.ledger.pending(manifest('/pageIndex/interactions/' + i), 'UI_RUNNER_OBSERVED_INTERACTION_NOT_MATCHED');
    // These evidence classes are retained in their entirety; runtime comparator coverage is explicit.
    for (const key of ['documents', 'resources', 'stateResources']) {
      for (const [i] of e.pageIndex[key].entries()) await this.ledger.pending(manifest('/pageIndex/' + key + '/' + i), key === 'documents' ? 'UI_RUNNER_DOCUMENT_FIELDS_PENDING' : 'UI_RUNNER_RESOURCE_FIELDS_PENDING', { coverage: 'ENTIRE_REFERENCED_ROW' });
    }
    for (const ref of this.store.refs.values()) {
      await this.ledger.check('ARTIFACT_INTEGRITY', 'PASSED', this.store.ref(ref.artifactId), { sha256: ref.sha256, byteLength: ref.byteLength }, { sha256: ref.sha256, byteLength: ref.byteLength });
      if (ref.completeness !== 'COMPLETE') await this.ledger.pending(this.store.ref(ref.artifactId), 'UI_RUNNER_ARTIFACT_INCOMPLETE');
      const jsonKind = /JSON$/.test(ref.kind) || /(?:json)(?:;|$)/i.test(ref.contentType ?? '');
      if (!jsonKind) {
        if (!this.usedPaths.has(ref.artifactId)) await this.ledger.pending(this.store.ref(ref.artifactId), 'UI_RUNNER_ARTIFACT_CONTENT_COMPARATOR_PENDING', { coverage: 'ENTIRE_ARTIFACT' });
        continue;
      }
      let data;
      try { data = await this.store.json(ref.artifactId); } catch { await this.ledger.pending(this.store.ref(ref.artifactId), 'UI_RUNNER_ARTIFACT_CONTENT_UNREADABLE'); continue; }
      for (const field of leaves(data)) if (!this.isUsed(ref.artifactId, field.pointer)) await this.ledger.pending(this.store.ref(ref.artifactId, field.pointer), 'UI_RUNNER_ARTIFACT_FIELD_COMPARATOR_PENDING');
    }
    const collectionPointers = new Set(['/journey/actions', '/pageIndex/states', '/pageIndex/interactions', '/bundle/fixtures', '/pageIndex/documents', '/pageIndex/resources', '/pageIndex/stateResources', '/bundle/artifacts']);
    async function visit(value, pointer, ledger) {
      if (collectionPointers.has(pointer)) return;
      if (value === null || typeof value !== 'object' || !Object.keys(value).length) { await ledger.pending(manifest(pointer), 'UI_RUNNER_SOURCE_METADATA_COMPARATOR_PENDING'); return; }
      for (const key of Object.keys(value).sort()) await visit(value[key], pointer + '/' + escapePointer(key), ledger);
    }
    await visit(e, '', this.ledger);
  }
}
