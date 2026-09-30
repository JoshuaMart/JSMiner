import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPeak } from './command.mjs';
import { summarize } from './report.mjs';
import { aggregate, qualityPass, rates, score } from './scoring.mjs';

test('quality counts unique observations, false positives and missed references', () => {
  assert.deepEqual(score(['a', 'b'], ['a', 'a', 'c']), { tp: 1, fp: 1, fn: 1 });
  assert.deepEqual(rates({ tp: 1, fp: 1, fn: 3 }), {
    tp: 1,
    fp: 1,
    fn: 3,
    precision: 0.5,
    recall: 0.25,
  });
  assert.equal(rates({ tp: 0, fp: 0, fn: 1 }).precision, null);
});
test('micro averages include negative fixtures and empty categories cannot qualify', () => {
  const categories = ['endpoints', 'secrets', 'gql_operations', 'subdomains'];
  const row = (value) => ({ quality: Object.fromEntries(categories.map((c) => [c, value])) });
  const quality = aggregate([row({ tp: 3, fp: 0, fn: 1 }), row({ tp: 0, fp: 2, fn: 0 })]);
  assert.equal(quality.endpoints.precision, 0.6);
  assert.equal(quality.endpoints.recall, 0.75);
  const thresholds = Object.fromEntries(
    categories.map((c) => [c, { precision: 0.6, recall: 0.75 }]),
  );
  assert.equal(qualityPass(quality, thresholds), true);
  assert.equal(qualityPass(aggregate([]), thresholds), false);
});

test('missing, ambiguous or invalid memory measurements never count as zero usage', () => {
  assert.equal(readPeak('noise\nJSMINER_METRICS:{"peak_bytes":123}\n'), 123);
  for (const value of [
    '',
    'JSMINER_METRICS:{invalid}\n',
    'JSMINER_METRICS:{"peak_bytes":0}\n',
    'JSMINER_METRICS:{"peak_bytes":12}\nJSMINER_METRICS:{"peak_bytes":13}\n',
  ])
    assert.equal(readPeak(value), null);
});

test('explicit evidence clipping qualifies, but detector failures and missing measurements do not', () => {
  const names = ['endpoints', 'secrets', 'gql_operations', 'subdomains'];
  const policy = {
    profiles: { full: ['jsluice'] },
    gated_profile: 'full',
    quality: Object.fromEntries(names.map((name) => [name, { precision: 1, recall: 1 }])),
    resources: {
      analysis_max_ms: 100,
      worker_peak_max_bytes: 100,
      api_peak_max_bytes: 100,
      artifact_max_bytes: 100,
      response_max_bytes: 100,
    },
  };
  const row = {
    case: 'fixture',
    profile: 'full',
    incomplete: false,
    status: 'partial',
    truncation: { reasons: ['evidence_count'] },
    tools: [{ name: 'jsluice', status: 'success' }],
    quality: Object.fromEntries(names.map((name) => [name, { tp: 1, fp: 0, fn: 0 }])),
    resources: {
      duration_ms: 1,
      worker_peak_bytes: 1,
      api_peak_bytes: 1,
      artifact_bytes: 1,
      response_bytes: 1,
      worker_samples: 1,
      missing_memory_samples: 0,
    },
  };
  const corpus = {
    cases: [
      {
        id: 'fixture',
        incomplete: false,
        expected: Object.fromEntries(
          names.map((name) => [
            name,
            name === 'secrets' ? [{ kind: 'github', values: ['fixture'] }] : ['fixture'],
          ]),
        ),
      },
    ],
  };
  const report = () => ({ rows: [structuredClone(row)], profiles: {} });
  assert.equal(summarize(report(), policy, corpus).passed, true);
  for (const mutate of [
    (r) => r.rows.pop(),
    (r) => r.rows.push(structuredClone(r.rows[0])),
    (r) => {
      r.rows[0].case = 'unknown';
    },
    (r) => {
      r.rows[0].incomplete = true;
    },
    (r) => {
      r.rows[0].tools = [];
    },
    (r) => {
      r.rows[0].tools[0].name = 'unexpected';
    },
    (r) => {
      r.rows[0].quality.endpoints.tp = 2;
    },
  ]) {
    const invalid = report();
    mutate(invalid);
    assert.equal(summarize(invalid, policy, corpus).passed, false);
  }
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const invalid = report();
    invalid.rows[0].resources.api_peak_bytes = value;
    assert.equal(summarize(invalid, policy, corpus).passed, false);
  }
  const pairCorpus = structuredClone(corpus);
  pairCorpus.cases.push({ ...structuredClone(corpus.cases[0]), id: 'second' });
  const pair = report();
  pair.rows.push({
    ...structuredClone(row),
    case: 'second',
    resources: { ...row.resources, duration_ms: 3 },
  });
  assert.equal(summarize(pair, policy, pairCorpus).profiles.full.median_ms, 2);
  pair.rows[1].case = 'fixture';
  assert.equal(summarize(pair, policy, pairCorpus).gates.matrix, false);
  row.tools[0].status = 'error';
  assert.equal(summarize(report(), policy, corpus).passed, false);
  row.tools[0].status = 'success';
  row.resources.missing_memory_samples = 1;
  assert.equal(summarize(report(), policy, corpus).passed, false);
});
