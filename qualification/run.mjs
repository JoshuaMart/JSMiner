import { arch, cpus, platform, totalmem } from 'node:os';
import { beginReport, hash, read, resolveImages, runCase } from './harness.mjs';
import { summarize } from './report.mjs';

const session = beginReport('report');
try {
  const policyBytes = read('policy.json'),
    corpusBytes = read('corpus.json');
  const policy = JSON.parse(policyBytes),
    corpus = JSON.parse(corpusBytes);
  const images = await resolveImages(session.signal),
    rows = [];
  const report = {
    version: 1,
    created_at: new Date().toISOString(),
    corpus_hash: hash(corpusBytes),
    policy_hash: hash(policyBytes),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cpu_count: cpus().length,
      memory_bytes: totalmem(),
      images,
    },
    rows,
    profiles: {},
    passed: false,
  };

  const save = () => session.save(report);
  save();
  for (const profile of Object.keys(policy.profiles))
    for (const fixture of corpus.cases) {
      rows.push(await runCase(fixture.id, profile, images, session.signal, report));
      save();
      console.info(
        `${rows.length}/${Object.keys(policy.profiles).length * corpus.cases.length} ${profile} ${fixture.id}`,
      );
    }
  summarize(report, policy, corpus);
  save();
  console.info(
    JSON.stringify({
      passed: report.passed,
      gates: report.gates,
      report: '.local/qualification/report.json',
    }),
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  session.close();
}
