import { readFile } from 'node:fs/promises';
import { digest, sha256 } from '../src/core.js';
import { fixtureFingerprint } from '../src/matcher.js';

const template = JSON.parse(await readFile(new URL('./plan-template.json', import.meta.url), 'utf8'));
export function fixture({ origin = 'http://127.0.0.1:3100', unavailable = false, duplicate = false, addUnknown = false } = {}) {
  const compilation = structuredClone(template), scope = compilation.source.scope, bytes = new Map(), artifacts = [];
  const doc = 'doc_sample', nav = 'nav_sample', frame = 'frame_main', step = 'step_nav';
  const context = { documentId: doc, navigationId: nav, frameId: frame, stepId: step };
  const artifact = (id, kind, value, contentType = 'application/json') => {
    const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); bytes.set(id, data);
    artifacts.push({ artifactId: id, kind, sha256: sha256(data), byteLength: data.length, contentType, completeness: 'COMPLETE', dataOrigin: 'OBSERVED_ENVIRONMENT_MANAGED' }); return id;
  };
  const headersRef = artifact('uia_headers', 'HEADERS_JSON', [['content-type', 'application/json']]);
  const responseRef = artifact('uia_response', 'HTTP_RESPONSE_BODY', { title: 'Observed item' });
  const requestHeaders = artifact('uia_request_headers', 'HEADERS_JSON', [['accept', '*/*']]);
  const inputValueRef = artifact('uia_action_value', 'ACTION_VALUE_JSON', { value: 'observed input' });
  const domRef = artifact('uia_dom', 'DOM_SNAPSHOT_JSON', { contractVersion: 'qagent.ui-dom-snapshot.v1', documentId: doc, nodes: [
    { nodeId: 'node_main', parentId: null, nodeType: 1, name: 'MAIN', attributes: [['data-testid', 'main']], text: '' },
    { nodeId: 'node_heading', parentId: 'node_main', nodeType: 1, name: 'H1', attributes: [['data-testid', 'heading']], text: '' },
    { nodeId: 'node_text', parentId: 'node_heading', nodeType: 3, name: '#text', attributes: [], text: 'Observed item' },
    { nodeId: 'node_input', parentId: 'node_main', nodeType: 1, name: 'INPUT', attributes: [['data-testid', 'query']], text: '' },
    { nodeId: 'node_button', parentId: 'node_main', nodeType: 1, name: 'BUTTON', attributes: [['data-testid', 'save']], text: '' },
  ], ...(addUnknown ? { futureProperty: 'must remain pending' } : {}) });
  const formRef = artifact('uia_form', 'FORM_STATE_JSON', { contractVersion: 'qagent.ui-form-state.v1', documentId: doc, fields: [{ nodeId: 'node_input', type: 'text', value: '', checked: false }], scroll: [] });
  const interaction = {
    eventId: 'uie_request', entryId: 'entry_sample', requestId: 'request_sample', ...context, requestSequence: 0, observedSequence: 1, redirectHop: 0, classification: 'BUSINESS_API', resourceType: 'Fetch',
    request: { logicalServiceKey: 'svc_sample', origin, method: 'GET', path: '/api/items', query: [['tag', 'one'], ['tag', 'two']], bodyRef: null, bodySha256: null, businessHeadersRef: requestHeaders, businessHeadersSha256: artifacts.find(a => a.artifactId === requestHeaders).sha256 },
    response: { networkStatus: unavailable ? 304 : 200, replayStatus: unavailable ? 304 : 200, bodyState: unavailable ? 'MISSING' : 'COMPLETE', bodySource: unavailable ? 'UNAVAILABLE' : 'NETWORK', bodyRef: unavailable ? null : responseRef, bodySha256: unavailable ? null : artifacts.find(a => a.artifactId === responseRef).sha256, headersRef, headersSha256: artifacts.find(a => a.artifactId === headersRef).sha256, contentType: 'application/json', cacheEvidenceVerified: false }, observedIssueCodes: []
  };
  const f = { ...structuredClone(interaction), fixtureId: 'uif_sample', availability: unavailable ? 'UNAVAILABLE' : 'READY', reasonCodes: unavailable ? ['UI_CACHE_BODY_UNAVAILABLE'] : [], match: { ...context, policyVersion: 'qagent_ui_observed_fixture_match_v1', requestFingerprint: fixtureFingerprint(interaction), occurrenceKey: 'occ_sample', occurrenceIndex: 0, orderBasis: 'OBSERVED_REQUEST_DISPATCH', causalProof: false }, consumption: { required: true, minimum: 1, maximum: 1, reuseAfterExhaustion: false, liveFallback: false } };
  const action = { ...context, actionId: 'action_nav', eventId: 'uie_nav', type: 'NAVIGATE', observedSequence: 0, relativeTimeUs: 0, destination: origin + '/items', inputValueRef: null, checked: null, position: null, scrollTarget: null, clickCount: null, target: null, stateBeforeId: null, stateAfterId: 'state_loaded' };
  const fill = { ...action, actionId: 'action_fill', eventId: 'uie_fill', type: 'FILL', destination: null, inputValueRef, observedSequence: 3, target: { observedMatchCount: 1, primaryLocator: { strategy: 'TEST_ID', value: 'query' }, candidateLocators: [], framePath: [] }, stateBeforeId: 'state_loaded', stateAfterId: null };
  const state = { ...context, stateId: 'state_loaded', checkpointId: 'checkpoint_loaded', checkpointEventId: 'uie_checkpoint', observedSequence: 2, stateSequence: 0, stability: 'STABLE', url: origin + '/items', domRef, layoutRef: null, htmlRef: null, formStateRef: formRef, screenshotRef: null, resourceManifestRef: null, structuralReference: { status: 'AVAILABLE', stable: true }, visualReference: { status: 'UNAVAILABLE', stable: false }, reasonCodes: [] };
  const source = { scope, captureId: 'uic_runner_sample', sourceHash: sha256('immutable observed source') };
  const envelope = { contractVersion: 'qagent.ui-page-evidence.v2', canonicalizerVersion: 'qagent.ui-canonical-json.v1', builderVersion: 'qagent_ui_bundle_builder_v5', bundleVersionId: 'urbv_runner_sample', source, profile: { bootstrap: { mode: 'UNAVAILABLE' } }, manifestState: 'SEALED', journey: { entryUrl: origin + '/items', actions: [action, fill], sourceBuildRef: null }, bundle: { artifacts, fixtures: duplicate ? [f, { ...structuredClone(f), fixtureId: 'uif_sample_second', eventId: 'uie_request_second', requestSequence: 1, match: { ...f.match, occurrenceIndex: 1 } }] : [f], applicationResources: { strategy: 'EXECUTE_TARGET_BUILD', archiveExecutionAllowed: false, observedCssJsAreFixtures: false } }, pageIndex: { states: [state], interactions: [interaction], documents: [{ ...context, initialUrl: origin + '/items', parentDocumentId: null }], resources: [], stateResources: [] }, qualification: { dimensions: { integrity: { status: 'READY' } }, counts: { referencedArtifacts: artifacts.length, verifiedArtifacts: artifacts.length } } };
  envelope.manifestHash = digest(envelope);
  const pin = { ...source, bundleVersionId: envelope.bundleVersionId, manifestHash: envelope.manifestHash };
  compilation.source = pin;
  const spec = compilation.specification; spec.scope = scope; spec.source = pin; spec.entryUrl = envelope.journey.entryUrl;
  const counts = [2, 1, 1, envelope.bundle.fixtures.length, 1, 0, 0, artifacts.length, 1];
  spec.plan.sections.forEach((s, i) => { s.count = counts[i]; });
  Object.assign(spec.coverage, { actionsTotal: 2, actionsPlanned: 2, checkpointsTotal: 1, checkpointsPlanned: 1, stableCheckpoints: 1, unstableCheckpoints: 0, interactionsTotal: 1, interactionsPlanned: 1, businessFixtures: envelope.bundle.fixtures.length, usableFixtures: unavailable ? 0 : envelope.bundle.fixtures.length, unavailableFixtures: unavailable ? envelope.bundle.fixtures.length : 0, sourceMetadataValues: 1, documentsTotal: 1, resourcesTotal: 0, stateResourceLinksTotal: 0, artifactsTotal: artifacts.length, referencedArtifacts: artifacts.length, verifiedArtifacts: artifacts.length, artifactBytesReferenced: artifacts.reduce((n, a) => n + a.byteLength, 0), validationUnitsPlanned: counts.reduce((a, b) => a + b, 0), validationUnitsPending: 1 });
  if (unavailable) spec.readiness.UI_REPLAY = { status: 'BLOCKED', reasonCodes: ['UI_TEST_DESIGN_REPLAY_FIXTURES_UNAVAILABLE'] };
  compilation.specificationHash = digest(spec); compilation.summary.coverage = structuredClone(spec.coverage);
  const profile = { scope, profileId: 'uiep_sample', name: 'Synthetic fixture', targetBaseUrl: origin, allowedOrigins: [origin], originMap: { [origin]: origin }, preparationKey: 'sample', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', stepTimeoutMs: 1000, modeTimeoutMs: 10000 };
  const claim = { contractVersion: 'qagent.ui-execution-claim.v1', batchId: 'uieb_sample', itemId: 'uiebi_sample', claimToken: 'sample-claim-token', leaseExpiresAt: Date.now() + 90000, scope, profile, targetBuildRef: 'build_sample', design: { testDesignVersionId: 'uitdv_sample', version: 1, compilation }, cancelRequested: false };
  const response = { contractVersion: 'qagent.ui-execution-source.v1', source: pin, specificationHash: compilation.specificationHash, envelope };
  return { compilation, claim, response, envelope, spec, profile, bytes, artifact, action, fill, state, context, fixture: f };
}
