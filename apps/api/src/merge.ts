import type { AnalyzeResponse, Endpoint, Secret } from '@jsminer/contracts';
export type Category = 'endpoints' | 'secrets' | 'gql_operations' | 'subdomains';
type Observation = AnalyzeResponse[Category][number];
function loss(response: AnalyzeResponse, reason: AnalyzeResponse['truncation']['reasons'][number]) {
  if (!response.truncation.reasons.includes(reason)) response.truncation.reasons.push(reason);
}
/** Bounded accumulation, including evidence retained across representations and detectors. */
export function merge(
  response: AnalyzeResponse,
  category: Category,
  values: Observation[],
  maxFindings = 200,
) {
  const existing = response[category] as Observation[];
  for (const value of values) {
    const found = existing.find((item) => item.id === value.id);
    if (found) {
      const evidence = [...found.evidence, ...value.evidence];
      const unique = [...new Map(evidence.map((e) => [JSON.stringify(e), e])).values()].sort(
        (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      if (unique.length > 5) loss(response, 'evidence_count');
      const representatives = [
        ...new Map(unique.map((e) => [`${e.tool}:${'rule_id' in e ? e.rule_id : ''}`, e])).values(),
      ];
      const ranked = [...representatives, ...unique.filter((e) => !representatives.includes(e))];
      found.evidence = ranked
        .slice(0, 5)
        .sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ) as typeof found.evidence;
      if (category === 'secrets')
        (found as Secret).rule_id =
          [(found as Secret).rule_id, (value as Secret).rule_id].sort()[0] ??
          (found as Secret).rule_id;
    } else if (existing.length < maxFindings) existing.push(value);
    else loss(response, 'finding_count');
  }
  existing.sort((a, b) => a.id.localeCompare(b.id));
}
export function finalize(
  response: AnalyzeResponse,
  sensitive: string[],
  incomplete: boolean,
  mac: (v: string) => string,
  maxFindings = 200,
) {
  if (incomplete) {
    response.endpoints = [];
    response.gql_operations = [];
    response.subdomains = [];
    loss(response, 'finding_count');
    return;
  }
  sensitive.sort((a, b) => b.length - a.length);
  const mask = (s: string) => {
    let value = s;
    for (const secret of sensitive)
      value = value
        .replaceAll(secret, 'REDACTED')
        .replaceAll(encodeURIComponent(secret), 'REDACTED');
    return value;
  };
  const endpoints: Endpoint[] = response.endpoints.map((e) => {
    const value = mask(e.value),
      resolved_url = e.resolved_url === null ? null : mask(e.resolved_url);
    const query_params = [...new Set(e.query_params.map(mask))].sort(),
      body_params = [...new Set(e.body_params.map(mask))].sort();
    return {
      ...e,
      value,
      resolved_url,
      query_params,
      body_params,
      id: `end_${mac(JSON.stringify([value, resolved_url, e.method, e.kind, e.dynamic, query_params, body_params]))}`,
    };
  });
  response.endpoints = [];
  const bounded = endpoints.filter((e) => {
    if (
      Buffer.byteLength(e.value) > 2048 ||
      (e.resolved_url && Buffer.byteLength(e.resolved_url) > 2048) ||
      [...e.query_params, ...e.body_params].some((p) => Buffer.byteLength(p) > 128)
    ) {
      loss(response, 'field_bytes');
      return false;
    }
    if (e.resolved_url) {
      try {
        const url = new URL(e.resolved_url);
        if (!['http:', 'https:'].includes(url.protocol)) e.resolved_url = null;
      } catch {
        e.resolved_url = null;
      }
    }
    e.id = `end_${mac(JSON.stringify([e.value, e.resolved_url, e.method, e.kind, e.dynamic, e.query_params, e.body_params]))}`;
    return true;
  });
  merge(response, 'endpoints', bounded, maxFindings);
  // A secret can appear in a GraphQL identifier or hostname: omit instead of fabricating syntax.
  for (const category of ['gql_operations', 'subdomains'] as const) {
    const safe = response[category].filter((value) => {
      const { id: _id, evidence: _evidence, ...fields } = value;
      const containsSecret = (field: unknown): boolean => {
        if (typeof field === 'string') return mask(field) !== field;
        if (Array.isArray(field)) return field.some(containsSecret);
        if (field && typeof field === 'object') return Object.values(field).some(containsSecret);
        return false;
      };
      // Test observed values, not JSON property names or generated hashes/identifiers.
      const observed = Object.entries(fields)
        .filter(([key]) => !['document_hash', 'endpoint_id'].includes(key))
        .map(([, value]) => value);
      if (containsSecret(observed)) {
        loss(response, 'field_bytes');
        return false;
      }
      return true;
    });
    if (category === 'gql_operations')
      response.gql_operations = safe as AnalyzeResponse['gql_operations'];
    else response.subdomains = safe as AnalyzeResponse['subdomains'];
  }
}
