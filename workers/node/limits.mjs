// Leave room for the fixed envelope, partial status and loss reasons.
export const FINDING_BYTES = 2 * 1024 * 1024 - 1024;
export function findingLimit() {
  const limit = Number(process.env.JSMINER_MAX_FINDINGS ?? 200);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new Error('Invalid finding limit.');
  return limit;
}
export function findingCollector() {
  const limit = findingLimit();
  const findings = [];
  let bytes = 0;
  return {
    findings,
    add(finding) {
      const size = Buffer.byteLength(JSON.stringify(finding)) + 1;
      if (findings.length >= limit || bytes + size > FINDING_BYTES) return false;
      findings.push(finding);
      bytes += size;
      return true;
    },
  };
}
