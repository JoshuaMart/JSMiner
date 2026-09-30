// A hand-authored webpack bundle with 2 MiB of padding on a single line.
export const stressFixture = {
  id: 'large-single-line',
  content: `(self.webpackChunk=self.webpackChunk||[]).push([[1],{42:function(module,exports,require){fetch("/api/large");}}]);/*${'x'.repeat(2 * 1024 * 1024)}*/`,
  reference_domains: ['example.com'],
  expected: { endpoints: ['/api/large'], secrets: [], gql_operations: [], subdomains: [] },
  incomplete: false,
};
