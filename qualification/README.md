# Qualification v0.1

Run from the repository root after `pnpm build` and `pnpm worker:build`:

```sh
pnpm qualify:build
pnpm qualify
pnpm qualify:stress
pnpm qualify:clean
```

`policy.json` fixes acceptance thresholds before measurement. `corpus.json` contains only hand-authored, owned fixtures. No discovered URL is requested and no credential is verified. Both workers retain `--network=none`; the clean-install test captures only its own loopback HTTP fixture.

The eight profiles cross four representation plans (original, webcrack, Wakaru, webcrack → Wakaru) with two secret-detector plans (jsluice, jsluice + TruffleHog). GraphQL and domain detection remain enabled in every profile. The original source is always included. The gate applies to `chain-combined`; other profiles are comparisons.

Scoring uses unique endpoint values after redaction, secret family plus the project HMAC of annotated synthetic values, GraphQL operation type/name, and subdomain hostname. It does not evaluate parameter metadata, confidence calibration or schema correctness of GraphQL operations. Duplicate evidence from representations counts once. Micro precision = TP/(TP+FP), recall = TP/(TP+FN). An empty denominator yields `null`, never a perfect score. Negative fixtures contribute false positives. Incomplete and dynamic cases remain in quality scoring, but are excluded from the successful-tools gate. Valid inputs require every tool to succeed; an explicit partial response caused solely by evidence clipping remains valid under the compact API contract.

Each analysis runs in a fresh API process, with an empty private store and cache disabled. One pass per case/profile measures wall time including Docker launch and cleanup; image download/build time is excluded. These nine small fixtures do not establish production latency percentiles or accuracy on arbitrary bundles. The single synthetic GitHub family is only a secret-detector smoke test, not a broad recall estimate.

The qualification-only Go wrapper launches the production entrypoint, waits for all direct child work, and reads the container cgroup's `memory.peak` (v2) or `memory.max_usage_in_bytes` (v1), including descendants and wrapper overhead. It emits one metrics line on stderr. Missing, nonfinite or nonpositive memory measurements fail the resource gate. The full case/profile matrix, exact tool sets and annotated reference counts are checked before aggregation. These instrumented image IDs differ from production; both are recorded. The harness verifies that instrumented images include the current production layers, pins execution to immutable image IDs and rejects changes to corpus/policy hashes during a run. API peak RSS uses `process.resourceUsage().maxRSS` in a fresh process and excludes the Docker daemon. Source volume and total logical artifact usage are recorded separately. No raw worker stderr or secret values are saved in reports.

`pnpm qualify:stress` additionally exercises an owned, single-line webpack fixture padded to 2 MiB and verifies bounded source reads under the same resource ceilings.

Generated reports go to `.local/qualification/`. Run `pnpm qualify:clean` after the measurements, not concurrently: it copies tracked and untracked non-ignored repository files into a temporary workspace, installs frozen dependencies, builds, starts the actual API, exercises capture/full analysis/cache/source/access control, stops it, and runs offline expiry purge. It uses the already-built production worker images; building those from their pinned lockfiles is a prerequisite. It deletes its own temporary workspace afterwards.

A directory lock rejects concurrent qualification jobs. Reports are replaced atomically and initialized to `passed: false` before work starts, so early failures cannot preserve a previous success. SIGINT/SIGTERM cancels subprocesses, waits for exit (with forced termination after ten seconds), and removes only containers belonging to that run. After an uncatchable SIGKILL or host crash, inspect remaining qualification processes and containers before manually removing `.local/qualification/.lock`. To reproduce a checked-in result, use its corpus/policy hashes and image IDs; CPU, host memory and Node version are recorded. Timings vary with the host and Docker load. No v0.1 release or deployment is performed by these commands.
