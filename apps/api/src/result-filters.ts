import type { AnalyzeRequest, Confidence, Endpoint } from '@jsminer/contracts';
import { getDomain } from 'tldts';

const hostname = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '');
const domain = (host: string) => getDomain(host, { allowPrivateDomains: true }) ?? host;

export function confidenceFilter(minimum: Confidence = 'low') {
  const rank = { low: 0, medium: 1, high: 2 };
  return (finding: { confidence: Confidence }) => rank[finding.confidence] >= rank[minimum];
}

/** Presentation filter only: no DNS, requests or changes to cached worker output. */
export function endpointFilter(request: AnalyzeRequest): (endpoint: Endpoint) => boolean {
  const scope = request.endpoint_scope ?? 'all';
  const base = request.base_url ?? request.url;
  const reference = base ? hostname(new URL(base)) : null;
  const referenceDomain = reference ? domain(reference) : null;
  const excluded = (request.exclude_extensions ?? []).map(
    (extension) => `.${extension.replace(/^\./, '').toLowerCase()}`,
  );
  if (scope === 'all' && !excluded.length) return () => true;

  return (endpoint) => {
    let url: URL;
    try {
      url = new URL(endpoint.resolved_url ?? endpoint.value, base ?? 'https://unresolved.invalid/');
    } catch {
      // A restricted scope requires a determinable destination.
      return scope === 'all';
    }
    if (scope !== 'all') {
      const host = hostname(url);
      if (!reference || !['http:', 'https:'].includes(url.protocol)) return false;
      if (endpoint.dynamic && host.includes('expr')) return false;
      if (scope === 'same_fqdn' ? host !== reference : domain(host) !== referenceDomain)
        return false;
    }
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Malformed escapes do not prevent matching a literal extension.
    }
    const filename = (path.split('/').at(-1) ?? '').toLowerCase();
    return !excluded.some((extension) => filename.endsWith(extension));
  };
}
