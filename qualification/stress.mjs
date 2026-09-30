import assert from 'node:assert/strict';
import { beginReport, hash, read, resolveImages, runCase } from './harness.mjs';
import { resourcePass, toolsMatch } from './report.mjs';

const session = beginReport('stress');
try {
  const policyBytes = read('policy.json'),
    policy = JSON.parse(policyBytes);
  const inputs = { policy_hash: hash(policyBytes), corpus_hash: hash(read('corpus.json')) };
  const images = await resolveImages(session.signal);
  const result = await runCase(
    'large-single-line',
    'chain-combined',
    images,
    session.signal,
    inputs,
  );
  result.images = images;
  result.passed =
    result.case === 'large-single-line' &&
    result.profile === 'chain-combined' &&
    result.status === 'complete' &&
    toolsMatch(result, policy.profiles['chain-combined']) &&
    Object.values(result.quality).every((q) => q.fp === 0 && q.fn === 0) &&
    result.quality.endpoints.tp === 1 &&
    result.tools.every((t) => t.status === 'success') &&
    resourcePass(result.resources, policy.resources);
  session.save(result);
  console.info(JSON.stringify({ passed: result.passed, resources: result.resources }));
  assert.equal(result.passed, true, 'Stress qualification failed; inspect the saved report.');
} finally {
  session.close();
}
