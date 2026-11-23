import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function pairExitCode(pair) {
  if (!Array.isArray(pair?.modes) || pair.modes.length !== 2 || pair.modes[0]?.mode !== 'UI_REPLAY' || pair.modes[1]?.mode !== 'UI_LIVE' || pair.modes.some(m => !m.counts)) return 2;
  const fields = ['actionsPlanned', 'actionsExecuted', 'checkpointsPlanned', 'checkpointsReached', 'checksPassed', 'checksFailed', 'checksPending', 'fixturesConsumed', 'requestsObserved'];
  if (pair.modes.some(m => fields.some(k => !Number.isSafeInteger(m.counts[k]) || m.counts[k] < 0))) return 2;
  if (pair.modes.some(m => m.status === 'CANCELLED')) return 130;
  if (pair.modes.some(m => m.status === 'FAILED' || m.counts.checksFailed > 0)) return 1;
  if (pair.modes.length !== 2 || pair.modes.some(m => m.status !== 'PASSED' || !m.executionPerformed || m.counts.checksPassed === 0 || m.counts.checksPending > 0 || m.counts.actionsExecuted !== m.counts.actionsPlanned || m.counts.checkpointsReached !== m.counts.checkpointsPlanned)) return 2;
  return 0;
}
export function batchExitCode(batch) {
  if (!batch || !Array.isArray(batch.items) || batch.items.length === 0) return 2;
  if (batch.status === 'CANCELLED') return 130;
  if (batch.items?.some(i => i.result && pairExitCode(i.result) === 1) || batch.gate === 'FAILED') return 1;
  if (batch.status !== 'COMPLETED' || batch.gate !== 'PASSED' || batch.items?.some(i => !i.result || pairExitCode(i.result) !== 0)) return 2;
  return 0;
}
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function pairJUnit(pair, name = 'observed-ui') {
  const validPass = m => m.status === 'PASSED' && m.executionPerformed && m.counts.checksPassed > 0 && m.counts.checksFailed === 0 && m.counts.checksPending === 0 && Number.isSafeInteger(m.counts.actionsPlanned) && m.counts.actionsExecuted === m.counts.actionsPlanned && Number.isSafeInteger(m.counts.checkpointsPlanned) && m.counts.checkpointsReached === m.counts.checkpointsPlanned;
  const cases = pair.modes.map(m => {
    const details = xml(JSON.stringify({ status: m.status, counts: m.counts, reasonCodes: m.reasonCodes, reportPages: m.reportPages ?? [] }));
    const result = validPass(m) ? '' : m.status === 'FAILED' ? '<failure message="Observed UI assertion failed">' + details + '</failure>' : '<error message="UI execution incomplete">' + details + '</error>';
    return '<testcase classname="' + xml(name) + '" name="' + xml(m.mode) + '">' + result + '</testcase>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="' + xml(name) + '" tests="2" failures="' + pair.modes.filter(m => m.status === 'FAILED').length + '" errors="' + pair.modes.filter(m => m.status !== 'FAILED' && !validPass(m)).length + '">' + cases.join('') + '</testsuite>\n';
}
export async function writePairReports(directory, pair, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'result.json'), JSON.stringify(pair, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'junit.xml'), pairJUnit(pair, name), { mode: 0o600 });
}
