// Leave room for the fixed envelope, partial status and loss reasons.
export const FINDING_BYTES = 2 * 1024 * 1024 - 1024;
export function findingCollector() {
  const findings = [];
  let bytes = 0;
  return {
    findings,
    add(finding) {
      const size = Buffer.byteLength(JSON.stringify(finding)) + 1;
      if (findings.length >= 200 || bytes + size > FINDING_BYTES) return false;
      findings.push(finding);
      bytes += size;
      return true;
    },
  };
}
