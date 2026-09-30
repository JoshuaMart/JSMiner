import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBatch, encodeBatch } from '../dist/batch.js';

const frame = (index, output = 'ok', error = null) =>
  `${JSON.stringify({ index, output: error ? null : Buffer.from(output).toString('base64'), error })}\n`;
const execution = (output, extra = {}) => ({
  status: 'success',
  errorCode: null,
  durationMs: 5,
  version: 'fixture',
  output: Buffer.from(output),
  ...extra,
});
test('batch frames preserve module order, errors and complete prefixes on timeout', () => {
  const result = decodeBatch(
    execution(`${frame(0) + frame(1, '', 'worker_failed')}{"index":2`, {
      status: 'timeout',
      errorCode: 'timeout',
    }),
    3,
  );
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].output.toString(), 'ok');
  assert.equal(result.results[1].errorCode, 'worker_failed');
  assert.equal(result.terminal.errorCode, 'timeout');
  assert.equal(result.terminal.output.length, 0);
});
test('batch protocol rejects reordering, duplicates, extra frames and malformed output', () => {
  for (const tail of [
    frame(0),
    frame(2),
    '{"index":1,"output":"???","error":null}\n',
    `${frame(1)}{`,
    frame(1) + frame(2),
  ]) {
    const result = decodeBatch(execution(frame(0) + tail), 2);
    assert.equal(result.terminal.errorCode, 'invalid_worker_output');
    assert.equal(result.results[0].output.toString(), 'ok');
  }
  assert.equal(decodeBatch(execution(frame(0)), 2).terminal.errorCode, 'incomplete_batch');
  assert.equal(decodeBatch(execution(frame(0) + frame(1)), 2).terminal, null);
});
test('batch input encodes exact bytes and has an explicit module bound', () => {
  const contents = [Buffer.from('\ufeffconst x=1;\r\n'), Buffer.alloc(0)];
  const lines = encodeBatch(contents).toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    lines.map((v) => Buffer.from(v.input, 'base64')),
    contents,
  );
  assert.deepEqual(
    lines.map((v) => v.index),
    [0, 1],
  );
  assert.throws(() => encodeBatch([]));
  assert.throws(() => encodeBatch(Array(2001).fill(Buffer.alloc(0))));
});
