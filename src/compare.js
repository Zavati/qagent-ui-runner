import { insist, same, escapePointer, checkAbort } from './core.js';

const inert = new Set(['script', 'style', 'template', 'noscript']);
export const cleanText = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
export function locatorsFor(nodes) {
  const ids = new Map(), elements = [], attributes = new Map(), counts = new Map(), orders = new Map(), siblings = new Map(), paths = new Map();
  for (const n of nodes) {
    insist(typeof n.nodeId === 'string' && !ids.has(n.nodeId) && (n.parentId === null || ids.has(n.parentId)), 'UI_RUNNER_DOM_REFERENCE_INVALID');
    ids.set(n.nodeId, n);
    if (n.nodeType !== 1) continue;
    insist(Array.isArray(n.attributes) && n.attributes.every(a => Array.isArray(a) && a.length === 2 && a.every(v => typeof v === 'string')), 'UI_RUNNER_DOM_ATTRIBUTES_INVALID');
    elements.push(n); attributes.set(n.nodeId, new Map(n.attributes));
    const key = n.parentId + '\0' + n.name.toLowerCase(); siblings.set(key, (siblings.get(key) ?? 0) + 1); orders.set(n.nodeId, siblings.get(key));
    for (const key of ['id', 'data-testid']) { const value = attributes.get(n.nodeId).get(key); if (value) counts.set(key + '\0' + value, (counts.get(key + '\0' + value) ?? 0) + 1); }
  }
  function path(n, depth = 0) {
    if (paths.has(n.nodeId)) return paths.get(n.nodeId);
    if (depth > 100 || !/^[a-zA-Z][a-zA-Z0-9-]{0,100}$/.test(n.name)) return null;
    const parent = ids.get(n.parentId), head = parent?.nodeType === 1 ? path(parent, depth + 1) : '';
    const result = head === null ? null : (head ? head + ' > ' : '') + n.name.toLowerCase() + ':nth-of-type(' + orders.get(n.nodeId) + ')';
    paths.set(n.nodeId, result); return result;
  }
  const result = new Map();
  for (const n of elements) {
    const attrs = attributes.get(n.nodeId);
    if (inert.has(n.name.toLowerCase()) || attrs.get('data-qagent-redacted') === 'true') continue;
    const testId = attrs.get('data-testid'), id = attrs.get('id');
    if (testId && counts.get('data-testid\0' + testId) === 1) result.set(n.nodeId, { strategy: 'TEST_ID', value: testId });
    else if (id && counts.get('id\0' + id) === 1) result.set(n.nodeId, { strategy: 'CSS', value: '[id=' + JSON.stringify(id) + ']' });
    else { const value = path(n); if (value && value.length <= 2048) result.set(n.nodeId, { strategy: 'CSS', value }); }
  }
  return result;
}
export function locator(page, description) {
  insist(description && typeof description.value === 'string' && description.value.length <= 2048, 'UI_RUNNER_LOCATOR_UNSUPPORTED');
  if (description.strategy === 'TEST_ID') return page.getByTestId(description.value);
  insist(description.strategy === 'CSS' && !description.value.includes('>>'), 'UI_RUNNER_LOCATOR_UNSUPPORTED');
  return page.locator('css=' + description.value);
}
export async function exactLocator(page, description, timeout) {
  const l = locator(page, description); await l.waitFor({ state: 'attached', timeout });
  insist(await l.count() === 1, 'UI_RUNNER_LOCATOR_AMBIGUOUS'); return l;
}

export class CheckpointComparator {
  constructor({ page, store, ledger, mode, profile, spec, binding, accounting, signal }) { Object.assign(this, { page, store, ledger, mode, profile, spec, binding, accounting, signal }); }
  async compare(kind, expected, actual, sourceRef, { data = false, tolerance } = {}) {
    const equal = tolerance === undefined ? same(expected, actual) : Array.isArray(actual) && actual.length === expected.length && expected.every((x, i) => Math.abs(x - actual[i]) <= tolerance);
    // Changed live business values are a recorded delta, awaiting acceptance; missing UI stays a failed assertion.
    const status = equal ? 'PASSED' : data && this.mode === 'UI_LIVE' ? 'PENDING' : 'FAILED';
    const reason = !equal && status === 'PENDING' ? 'UI_RUNNER_LIVE_OBSERVED_DATA_CHANGED' : !equal ? 'UI_RUNNER_OBSERVED_VALUE_MISMATCH' : undefined;
    await this.ledger.check(kind, status, sourceRef, expected, actual, reason);
    if (status === 'PENDING') await this.ledger.append('pending', { sourceRef, reasonCode: reason, kind });
    if (sourceRef?.artifactId && !['ELEMENT_PRESENT_UNIQUE', 'DIRECT_TEXT_EQUALS'].includes(kind)) this.accounting.used(sourceRef.artifactId, sourceRef.pointer, typeof expected === 'object' && expected !== null);
    return equal;
  }
  async run(state, stateIndex) {
    checkAbort(this.signal);
    const stateRef = { pointer: '/pageIndex/states/' + stateIndex, manifestHash: this.spec.source.manifestHash };
    if (state.stability !== 'STABLE') { await this.ledger.pending(stateRef, 'UI_RUNNER_CHECKPOINT_UNSTABLE'); return false; }
    if (!state.domRef || state.structuralReference?.status === 'UNAVAILABLE') { await this.ledger.pending(stateRef, 'UI_RUNNER_CHECKPOINT_DOM_UNAVAILABLE'); return false; }
    if (state.url) await this.compare('URL_MATCHES', this.binding.toTarget(state.url), this.page.url(), { ...stateRef, pointer: stateRef.pointer + '/url' });
    const dom = await this.store.json(state.domRef, 'DOM_SNAPSHOT_JSON');
    insist(dom.contractVersion === 'qagent.ui-dom-snapshot.v1' && dom.documentId === state.documentId && Array.isArray(dom.nodes), 'UI_RUNNER_ARTIFACT_CONTEXT_MISMATCH');
    const map = locatorsFor(dom.nodes), handles = new Map(), textsByParent = new Map();
    dom.nodes.forEach((n, i) => { if (n.nodeType === 3 && n.parentId !== null) { const group = textsByParent.get(n.parentId) ?? []; group.push({ n, i }); textsByParent.set(n.parentId, group); } });
    this.accounting.used(state.domRef, '/contractVersion'); this.accounting.used(state.domRef, '/documentId');
    for (let ni = 0; ni < dom.nodes.length; ni++) {
      checkAbort(this.signal); const node = dom.nodes[ni], base = '/nodes/' + ni, ref = p => this.store.ref(state.domRef, base + p);
      this.accounting.used(state.domRef, base + '/nodeId'); this.accounting.used(state.domRef, base + '/parentId');
      if (node.nodeType !== 1) continue;
      const description = map.get(node.nodeId);
      if (!description) { await this.ledger.pending(ref(''), 'UI_RUNNER_NODE_NOT_REMAPPABLE'); continue; }
      const l = locator(this.page, description); let count = await l.count();
      if (!count) { try { await l.waitFor({ state: 'attached', timeout: this.profile.stepTimeoutMs }); count = await l.count(); } catch {} }
      await this.compare('ELEMENT_PRESENT_UNIQUE', 1, count, ref(''));
      this.accounting.used(state.domRef, base + '/nodeType');
      if (count !== 1) continue;
      handles.set(node.nodeId, l);
      await this.compare('ELEMENT_TAG', node.name.toLowerCase(), await l.evaluate(el => el.tagName.toLowerCase()), ref('/name'));
      for (let ai = 0; ai < node.attributes.length; ai++) {
        const [name, value] = node.attributes[ai];
        if (value === '[REDACTED]') { await this.ledger.pending(ref('/attributes/' + ai), 'UI_RUNNER_REDACTED_VALUE'); continue; }
        let expected = value;
        if (['href', 'src', 'action'].includes(name) && /^https?:\/\//.test(value)) expected = this.binding.toTarget(value);
        await this.compare('ATTRIBUTE_EQUALS', expected, await l.getAttribute(name), ref('/attributes/' + ai + '/1'), { data: true });
        this.accounting.used(state.domRef, base + '/attributes/' + ai + '/0');
      }
      const textNodes = textsByParent.get(node.nodeId) ?? [];
      if (textNodes.length && !textNodes.some(({ n }) => n.text === '[REDACTED]')) {
        const expected = cleanText(textNodes.map(({ n }) => n.text).join(''));
        const actual = cleanText(await l.evaluate(el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('')));
        await this.compare('DIRECT_TEXT_EQUALS', expected, actual, ref(''), { data: true });
        for (const { i } of textNodes) for (const k of ['text', 'nodeType', 'name', 'attributes']) this.accounting.used(state.domRef, '/nodes/' + i + '/' + k);
      }
      // Element text in this capture contract is empty; text-node records carry the observed text.
      if (node.text === '') this.accounting.used(state.domRef, base + '/text');
    }
    if (state.formStateRef) {
      const form = await this.store.json(state.formStateRef, 'FORM_STATE_JSON');
      insist(form.contractVersion === 'qagent.ui-form-state.v1' && form.documentId === state.documentId && Array.isArray(form.fields), 'UI_RUNNER_ARTIFACT_CONTEXT_MISMATCH');
      for (const k of ['contractVersion', 'documentId']) this.accounting.used(state.formStateRef, '/' + k);
      for (let i = 0; i < form.fields.length; i++) {
        const f = form.fields[i], l = handles.get(f.nodeId), base = '/fields/' + i, ref = p => this.store.ref(state.formStateRef, base + p);
        if (!l || f.type === 'file') { await this.ledger.pending(ref(''), 'UI_RUNNER_FORM_NODE_UNAVAILABLE'); continue; }
        this.accounting.used(state.formStateRef, base + '/nodeId');
        await this.compare('FORM_TYPE', f.type, await l.evaluate(el => el.type ?? el.tagName.toLowerCase()), ref('/type'));
        if (f.value !== '[REDACTED]') await this.compare('FORM_VALUE_EQUALS', f.value, await l.inputValue(), ref('/value'), { data: true });
        if (typeof f.checked === 'boolean') await this.compare('CHECKED_EQUALS', f.checked, await l.evaluate(el => Boolean(el.checked)), ref('/checked'), { data: true });
      }
      for (const [i, s] of (form.scroll ?? []).entries()) {
        const l = handles.get(s.nodeId), ref = p => this.store.ref(state.formStateRef, '/scroll/' + i + p);
        if (!l) { await this.ledger.pending(ref(''), 'UI_RUNNER_SCROLL_NODE_UNAVAILABLE'); continue; }
        const actual = await l.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
        const x = s.x ?? s.scrollX, y = s.y ?? s.scrollY;
        if (typeof x === 'number' && typeof y === 'number') await this.compare('SCROLL_EQUALS', [x, y], [actual.x, actual.y], ref(''), { tolerance: this.spec.profile.layoutTolerancePx });
      }
    }
    if (state.layoutRef) {
      const layout = await this.store.json(state.layoutRef, 'LAYOUT_JSON');
      insist(layout.contractVersion === 'qagent.ui-layout.v1' && layout.documentId === state.documentId && Array.isArray(layout.entries), 'UI_RUNNER_ARTIFACT_CONTEXT_MISMATCH');
      const vp = layout.viewport, current = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY }));
      const reliable = same(vp, current);
      await this.ledger.check('LAYOUT_RENDER_CONTEXT', reliable ? 'PASSED' : 'PENDING', this.store.ref(state.layoutRef, '/viewport'), vp, current, reliable ? undefined : 'UI_RUNNER_RENDER_CONTEXT_MISMATCH');
      for (const k of ['contractVersion', 'documentId', 'viewport']) this.accounting.used(state.layoutRef, '/' + k, k === 'viewport');
      for (let i = 0; i < layout.entries.length; i++) {
        const entry = layout.entries[i], l = handles.get(entry.nodeId), base = '/entries/' + i, ref = p => this.store.ref(state.layoutRef, base + p);
        if (!reliable || !l) { await this.ledger.pending(ref(''), reliable ? 'UI_RUNNER_LAYOUT_NODE_UNAVAILABLE' : 'UI_RUNNER_RENDER_CONTEXT_MISMATCH'); continue; }
        this.accounting.used(state.layoutRef, base + '/nodeId');
        const bounds = await l.boundingBox();
        await this.compare('BOUNDS_WITHIN_TOLERANCE', entry.bounds, bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null, ref('/bounds'), { tolerance: this.spec.profile.layoutTolerancePx });
        for (const [name, expected] of Object.entries(entry.styles ?? {})) {
          const actual = await l.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), name);
          await this.compare('COMPUTED_STYLE_EQUALS', expected, actual, ref('/styles/' + escapePointer(name)));
        }
      }
      // Historical OS/font/browser identity is not in v1 layout artifacts. Geometry is a scoped comparison.
      await this.ledger.pending(this.store.ref(state.layoutRef), 'UI_RUNNER_HISTORICAL_RENDER_PROFILE_UNPROVEN', { compared: 'VIEWPORT_DPR_SCROLL_GEOMETRY' });
    }
    if (state.screenshotRef) await this.ledger.pending(this.store.ref(state.screenshotRef), 'UI_RUNNER_SCREENSHOT_COMPARATOR_PENDING');
    return true;
  }
}
