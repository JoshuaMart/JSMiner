import { aggregate, categories, qualityPass } from './scoring.mjs';

const positive = (value) => Number.isFinite(value) && value > 0;
export function resourcePass(r, limits) {
  return (
    r &&
    [
      ['duration_ms', 'analysis_max_ms'],
      ['worker_peak_bytes', 'worker_peak_max_bytes'],
      ['api_peak_bytes', 'api_peak_max_bytes'],
      ['artifact_bytes', 'artifact_max_bytes'],
      ['response_bytes', 'response_max_bytes'],
    ].every(([field, limit]) => positive(r[field]) && r[field] <= limits[limit]) &&
    Number.isSafeInteger(r.worker_samples) &&
    r.worker_samples > 0 &&
    r.missing_memory_samples === 0
  );
}
export function toolsMatch(row, tools) {
  return (
    Array.isArray(row.tools) &&
    row.tools.length === tools.length &&
    new Set(row.tools.map((t) => t.name)).size === tools.length &&
    row.tools.every((t) => tools.includes(t.name))
  );
}

export function summarize(report, policy, corpus) {
  report.passed = false;
  report.profiles = {};
  const expected = new Map(corpus.cases.map((c) => [c.id, c]));
  const seen = new Set();
  const matrix =
    report.rows.length === expected.size * Object.keys(policy.profiles).length &&
    expected.size > 0 &&
    expected.size === corpus.cases.length &&
    report.rows.every((r) => {
      const fixture = expected.get(r.case),
        tools = policy.profiles[r.profile];
      const key = JSON.stringify([r.case, r.profile]);
      if (
        !fixture ||
        !tools ||
        seen.has(key) ||
        r.incomplete !== fixture.incomplete ||
        !toolsMatch(r, tools)
      )
        return false;
      seen.add(key);
      return categories.every((c) => {
        const q = r.quality?.[c];
        return (
          q &&
          ['tp', 'fp', 'fn'].every((k) => Number.isSafeInteger(q[k]) && q[k] >= 0) &&
          q.tp + q.fn ===
            new Set(
              fixture.expected[c].map((v) =>
                c === 'secrets' ? JSON.stringify([v.kind, [...new Set(v.values)].sort()]) : v,
              ),
            ).size
        );
      });
    });
  // Incomplete or malformed evidence must not be aggregated into a passing report.
  if (!matrix) {
    report.gates = { matrix: false, quality: false, valid_tool_runs: false, resources: false };
    return report;
  }
  for (const profile of Object.keys(policy.profiles)) {
    const selected = report.rows.filter((r) => r.profile === profile);
    const times = selected.map((r) => r.resources?.duration_ms).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    report.profiles[profile] = {
      quality: aggregate(selected),
      median_ms: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
      max_ms: times.at(-1),
      worker_peak_bytes: Math.max(...selected.map((r) => r.resources?.worker_peak_bytes)),
      api_peak_bytes: Math.max(...selected.map((r) => r.resources?.api_peak_bytes)),
      artifact_bytes: selected.reduce((n, r) => n + (r.resources?.artifact_bytes ?? 0), 0),
    };
  }
  const gated = report.rows.filter((r) => r.profile === policy.gated_profile);
  report.gates = {
    matrix,
    quality:
      !!report.profiles[policy.gated_profile] &&
      qualityPass(report.profiles[policy.gated_profile].quality, policy.quality),
    // Evidence clipping is a supported compact-response outcome, not a failed detector.
    valid_tool_runs: gated
      .filter((r) => !r.incomplete)
      .every(
        (r) =>
          r.tools.every((t) => t.status === 'success') &&
          (r.status === 'complete' ||
            (r.status === 'partial' &&
              r.truncation?.reasons?.length > 0 &&
              r.truncation.reasons.every((reason) => reason === 'evidence_count'))),
      ),
    resources: report.rows.every((r) => resourcePass(r.resources, policy.resources)),
  };
  report.passed = Object.values(report.gates).every(Boolean);
  return report;
}
