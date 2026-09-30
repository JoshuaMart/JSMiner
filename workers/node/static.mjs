import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseJS } from '@babel/parser';
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  KnownFragmentNamesRule,
  NoFragmentCyclesRule,
  parse,
  print,
  UniqueFragmentNamesRule,
  UniqueOperationNamesRule,
  validate,
} from 'graphql';
import { findingCollector } from './limits.mjs';

// These schema-independent rules only check the document's internal consistency.
// No remote schema, field/type validation or introspection is involved.
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields: { unused: { type: GraphQLString } } }),
});
const documentRules = [
  KnownFragmentNamesRule,
  NoFragmentCyclesRule,
  UniqueFragmentNamesRule,
  UniqueOperationNamesRule,
];

export const parseJavaScript = (content) =>
  parseJS(content, {
    sourceType: 'unambiguous',
    plugins: ['jsx'],
    allowReturnOutsideFunction: true,
  });
export function extract(content, tool, references = []) {
  const collector = findingCollector();
  const findings = collector.findings,
    reasons = new Set();
  let partial = false,
    incomplete = false;
  const ast = parseJavaScript(content);
  const stack = [ast];
  const add = (value, location) => {
    if (findings.length >= 200 || !collector.add({ ...value, location: location() })) {
      partial = true;
      reasons.add('finding_count');
    }
  };
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    let value,
      interpolated = false;
    if (node.type === 'StringLiteral') value = node.value;
    if (node.type === 'TemplateLiteral') {
      interpolated = node.expressions.length > 0;
      value = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
    }
    if (typeof value === 'string') {
      // Compute byte offsets only for retained candidates, not for every string in the bundle.
      const location = () => ({
        start_byte: Buffer.byteLength(content.slice(0, node.start)),
        end_byte: Buffer.byteLength(content.slice(0, node.end)),
      });
      if (
        tool === 'graphql' &&
        /^(?:\s|#[^\n]*(?:\n|$))*(?:query\b|mutation\b|subscription\b|fragment\b|\{)/u.test(value)
      ) {
        try {
          if (interpolated) throw new Error();
          const document = parse(value, { maxTokens: 50000 });
          if (validate(schema, document, documentRules).length) throw new Error();
          const document_hash = `sha256:${createHash('sha256').update(print(document)).digest('hex')}`;
          const fragments = new Map(
            document.definitions
              .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
              .map((d) => [d.name.value, d]),
          );
          for (const operation of document.definitions) {
            if (operation.kind !== Kind.OPERATION_DEFINITION) continue;
            const roots = new Set(),
              visited = new Set(),
              selections = [...operation.selectionSet.selections];
            while (selections.length) {
              const field = selections.pop();
              if (field.kind === Kind.FIELD) roots.add(field.name.value);
              else if (field.kind === Kind.INLINE_FRAGMENT)
                selections.push(...field.selectionSet.selections);
              else if (!visited.has(field.name.value)) {
                visited.add(field.name.value);
                const fragment = fragments.get(field.name.value);
                if (fragment) selections.push(...fragment.selectionSet.selections);
                else {
                  partial = true;
                  incomplete = true;
                }
              }
            }
            const variables = (operation.variableDefinitions ?? []).map((v) => ({
              name: v.variable.name.value,
              type: print(v.type),
            }));
            const name = operation.name?.value ?? null;
            if (
              (name && name.length > 128) ||
              variables.length > 128 ||
              variables.some((v) => v.name.length > 128 || v.type.length > 256) ||
              roots.size > 128 ||
              [...roots].some((v) => v.length > 128)
            ) {
              partial = true;
              reasons.add('field_bytes');
              continue;
            }
            add(
              {
                operation_type: operation.operation,
                name,
                variables,
                root_fields: [...roots].sort(),
                document_hash,
                endpoint_id: null,
              },
              location,
            );
          }
        } catch {
          partial = true;
          incomplete = true;
        }
      }
      if (tool === 'domains' && !interpolated) {
        let hostname;
        try {
          hostname = /^(?:https?:)?\/\//i.test(value)
            ? new URL(value.startsWith('//') ? `https:${value}` : value).hostname
            : value;
          hostname = domainToASCII(hostname.replace(/\.$/, '').toLowerCase());
        } catch {
          continue;
        }
        if (
          hostname.length <= 253 &&
          !isIP(hostname) &&
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
            hostname,
          )
        ) {
          const reference_domain = [...references]
            .sort((a, b) => b.length - a.length || a.localeCompare(b))
            .find((r) => hostname.endsWith(`.${r}`));
          if (reference_domain) add({ hostname, reference_domain }, location);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) stack.push(item);
      } else if (child && typeof child === 'object') stack.push(child);
    }
  }
  return {
    findings,
    partial,
    reasons: [...reasons],
    error_code: partial ? (incomplete ? 'incomplete_document' : 'output_truncated') : null,
  };
}
