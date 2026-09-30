/* Generated from schema.json. Run pnpm contracts:generate. */

export type JSMinerContract =
  | AnalyzeRequest
  | AnalyzeResponse
  | SourceListQuery
  | SourceReadQuery
  | SourceParams
  | ManifestParams
  | ManifestResponse
  | SourceResponse
  | ErrorResponse
  | HealthResponse;
/**
 * Exactly one of url/content. content must also be well-formed Unicode and <= 10 MiB UTF-8 (runtime refinement). Explicit domains requires reference_domains.
 */
export type AnalyzeRequest = AnalyzeRequest1 & AnalyzeRequest2;
export type AnalyzeRequest1 = {
  [k: string]: unknown;
};
export type HttpUrl = string;
export type ToolName = "webcrack" | "wakaru" | "jsluice" | "trufflehog" | "graphql" | "domains";
export type Hash = string;
export type Domain = string;
export type Identifier = string;
export type Confidence = "low" | "medium" | "high";
export type ModulePath = string;
export type Representation = "original" | "webcrack" | "wakaru";
export type CoverageStatus = "complete" | "partial" | "failed" | "not_requested";
export type ToolRun = ToolRun1 & ToolRun1;
export type Module = Module1;

export interface AnalyzeRequest2 {
  url?: HttpUrl;
  content?: string;
  /**
   * @minItems 1
   * @maxItems 6
   */
  tools?: [ToolName, ...ToolName[]];
  script_hash?: Hash;
  base_url?: HttpUrl;
  /**
   * @minItems 0
   * @maxItems 20
   */
  reference_domains?: Domain[];
}
export interface AnalyzeResponse {
  schema_version: "0.1";
  handle: Identifier;
  status: "complete" | "partial" | "failed";
  script_hash: Hash;
  expires_at: string;
  cache: {
    status: "hit" | "partial_hit" | "miss";
  };
  /**
   * @minItems 0
   * @maxItems 200
   */
  endpoints: Endpoint[];
  /**
   * @minItems 0
   * @maxItems 200
   */
  secrets: Secret[];
  /**
   * @minItems 0
   * @maxItems 200
   */
  gql_operations: GraphqlOperation[];
  /**
   * @minItems 0
   * @maxItems 200
   */
  subdomains: Subdomain[];
  coverage: {
    endpoints: CoverageStatus;
    secrets: CoverageStatus;
    gql_operations: CoverageStatus;
    subdomains: CoverageStatus;
  };
  /**
   * @minItems 1
   * @maxItems 6
   */
  tools: [ToolRun, ...ToolRun[]];
  truncation: {
    truncated: boolean;
    /**
     * @minItems 0
     * @maxItems 6
     */
    reasons: (
      "response_bytes" | "finding_count" | "evidence_count" | "artifact_bytes" | "module_count" | "field_bytes"
    )[];
  };
  /**
   * @minItems 0
   * @maxItems 32
   */
  warnings: {
    code: string;
    tool: ToolName | null;
  }[];
}
export interface Endpoint {
  id: Identifier;
  confidence: Confidence;
  /**
   * @minItems 1
   * @maxItems 5
   */
  evidence: [Evidence, ...Evidence[]];
  value: string;
  resolved_url: HttpUrl | null;
  method: string | null;
  kind: "http_call" | "navigation" | "resource" | "literal";
  dynamic: boolean;
  /**
   * @minItems 0
   * @maxItems 128
   */
  query_params: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  body_params: string[];
}
export interface Evidence {
  tool: ToolName;
  module_path: ModulePath;
  representation: Representation;
  location: Location | null;
}
export interface Location {
  start_byte: number;
  end_byte: number;
}
export interface Secret {
  id: Identifier;
  confidence: Confidence;
  /**
   * @minItems 1
   * @maxItems 5
   */
  evidence: [SecretEvidence, ...SecretEvidence[]];
  kind: string;
  rule_id: string;
  masked_value: "[REDACTED]";
  fingerprint: string;
  validation: "not_performed";
}
export interface SecretEvidence {
  tool: "jsluice" | "trufflehog";
  module_path: ModulePath;
  representation: Representation;
  location: Location | null;
  rule_id: string;
}
export interface GraphqlOperation {
  id: Identifier;
  confidence: Confidence;
  /**
   * @minItems 1
   * @maxItems 5
   */
  evidence: [Evidence, ...Evidence[]];
  operation_type: "query" | "mutation" | "subscription";
  name: string | null;
  /**
   * @minItems 0
   * @maxItems 128
   */
  variables: {
    name: string;
    type: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  root_fields: string[];
  document_hash: Hash;
  endpoint_id: Identifier | null;
}
export interface Subdomain {
  id: Identifier;
  confidence: Confidence;
  /**
   * @minItems 1
   * @maxItems 5
   */
  evidence: [Evidence, ...Evidence[]];
  hostname: Domain;
  reference_domain: Domain;
}
export interface ToolRun1 {
  name: ToolName;
  version: string | null;
  status: "success" | "partial" | "timeout" | "error" | "skipped";
  duration_ms: number;
  cache_hit: boolean;
  modules_analyzed: number | null;
  modules_available: number | null;
  error_code: string | null;
  input_path?: ModulePath | null;
}
export interface SourceListQuery {
  limit?: number;
  cursor?: string;
}
export interface SourceReadQuery {
  offset?: number;
  max_bytes?: number;
}
export interface SourceParams {
  handle: Identifier;
  path: ModulePath;
}
export interface ManifestParams {
  handle: Identifier;
}
export interface ManifestResponse {
  handle: Identifier;
  expires_at: string;
  /**
   * @minItems 0
   * @maxItems 100
   */
  modules: Module[];
  total_modules: number;
  next_cursor: string | null;
}
export interface Module1 {
  path: ModulePath;
  origin: Representation;
  parent_path: ModulePath | null;
  bytes: number;
  lines: number;
  hash: Hash;
}
export interface SourceResponse {
  handle: Identifier;
  path: ModulePath;
  content: string;
  offset: number;
  returned_bytes: number;
  total_bytes: number;
  next_offset: number | null;
}
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: Identifier;
  };
}
export interface HealthResponse {
  status: "ok";
  storage: "ready";
}
