import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { schema, ajv, validateContract, selectedTools } from '../dist/index.js';

const read = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));
for (const fixture of read('valid')) {
  test(`valid: ${fixture.name}`, () => {
    const original = structuredClone(fixture.data);
    const result = validateContract(fixture.schema,fixture.data);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(fixture.data,original,'Validation must not modify inputs');
  });
}
for (const fixture of read('invalid')) {
  test(`invalid: ${fixture.name}`, () => {
    const original = structuredClone(fixture.data);
    const result = validateContract(fixture.schema,fixture.data);
    assert.equal(result.ok,false);
    assert.equal(result.status,fixture.status);
    assert.deepEqual(fixture.data,original);
  });
}
test('all schema definitions compile as draft 2020-12', () => {
  for (const name of Object.keys(schema.$defs)) assert.ok(ajv.getSchema(`${schema.$id}#/$defs/${name}`));
});
test('response status, coverage and cache cannot overstate completed work', () => {
  const base=read('valid').find(f=>f.name==='complete').data;
  for(const mutate of [
    r=>{r.tools[0].status='timeout';r.tools[0].error_code='tool_timeout';},
    r=>{r.status='failed';},
    r=>{r.cache.status='hit';},
    r=>{r.coverage.secrets='not_requested';},
    r=>{r.tools[0].error_code='parse_error';},
    r=>{r.endpoints[0].evidence[0].tool='graphql';},
  ]) {const result=structuredClone(base);mutate(result);assert.equal(validateContract('AnalyzeResponse',result).ok,false);}
});
test('UTF-8 byte limit is independent of character count; lone surrogates rejected', () => {
  assert.equal(validateContract('AnalyzeRequest',{content:'é'.repeat(5*1024*1024)}).ok,true);
  assert.deepEqual(validateContract('AnalyzeRequest',{content:'é'.repeat(5*1024*1024+1)}),{ok:false,code:'script_too_large',status:413});
  assert.equal(validateContract('AnalyzeRequest',{content:'\ud800'}).status,422);
});
test('default tools are explicit and depend only on supplied reference domains', () => {
  assert.deepEqual(selectedTools({content:'x'}),['webcrack','wakaru','jsluice','trufflehog','graphql']);
  assert.equal(selectedTools({content:'x',reference_domains:['example.com']}).at(-1),'domains');
  assert.deepEqual(selectedTools({content:'x',tools:['wakaru']}),['wakaru']);
});
test('source fragments preserve UTF-8 byte accounting', () => {
  const base={handle:'ana_test',path:'original/bundle.js',content:'🥐',offset:0,returned_bytes:4,total_bytes:8,next_offset:4};
  assert.equal(validateContract('SourceResponse',base).ok,true);
  assert.equal(validateContract('SourceResponse',{...base,returned_bytes:2}).ok,false);
  assert.equal(validateContract('SourceResponse',{...base,content:'',returned_bytes:0,next_offset:0}).ok,false);
});
test('hash vectors preserve CDP-provided BOM, line endings and multibyte characters', () => {
  const {vectors,status,upstream}=read('hash-vectors');
  assert.equal(status,'upstream-code-verified-conditional');
  assert.equal(upstream.max_body_bytes,32*1024*1024);
  assert.equal(upstream.requires_loading_finished,true);
  for(const vector of vectors) {
    const bytes=Buffer.from(vector.utf8_hex,'hex');
    assert.equal(bytes.length,vector.byte_length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),vector.sha256);
    assert.deepEqual(Buffer.from(bytes.toString('utf8')),bytes);
    const content=bytes.toString('utf8');
    assert.equal(validateContract('AnalyzeRequest',{content,script_hash:`sha256:${vector.sha256}`}).ok,true);
    assert.equal(validateContract('AnalyzeRequest',{content,script_hash:vector.sha256}).ok,false);
  }
  assert.notEqual(vectors.find(v=>v.name==='ascii').sha256,vectors.find(v=>v.name==='bom').sha256);
  assert.notEqual(vectors.find(v=>v.name==='lf').sha256,vectors.find(v=>v.name==='crlf').sha256);
});
test('Fingerprinter and JSMiner hash the complete body beyond the former 2 MiB limit', () => {
  const {boundary_vectors}=read('hash-vectors');
  for(const vector of boundary_vectors) {
    const bytes=Buffer.from('a'.repeat(vector.repeat_count)+vector.suffix);
    assert.equal(bytes.length,vector.byte_length);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),vector.jsminer_sha256);
    assert.equal(vector.jsminer_sha256,vector.fingerprinter_sha256);
    if(vector.name==='utf8-across-2mib') {
      assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,2097152)));
    }
  }
  const suffixB=boundary_vectors.find(v=>v.name==='suffix-b-after-2mib');
  const suffixC=boundary_vectors.find(v=>v.name==='suffix-c-after-2mib');
  assert.equal(suffixB.repeat_count,suffixC.repeat_count);
  assert.notEqual(suffixB.fingerprinter_sha256,suffixC.fingerprinter_sha256);
});
test('documentation JSON examples remain valid contracts', () => {
  const text=readFileSync(new URL('../../../docs/src/content/docs/reference/api.md',import.meta.url),'utf8');
  const blocks=[...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]));
  const names=['AnalyzeRequest','AnalyzeResponse','ManifestResponse','SourceResponse','ErrorResponse'];
  assert.equal(blocks.length,names.length);
  blocks.forEach((b,i)=>assert.equal(validateContract(names[i],b).ok,true,`Invalid documentation example: ${names[i]}`));
});
