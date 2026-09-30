import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CleanupError, DockerWorker, JSLUICE_PROTOCOL, JSLUICE_VERSION } from '../dist/index.js';

const input = () => ({
  content: Buffer.from('const x = 1;'),
  timeoutMs: 15000,
  cleanupMs: 1000,
  memoryBytes: 128 * 1024 * 1024,
  cpus: 1,
  pids: 32,
  signal: new AbortController().signal,
});
const success = (output = '') => ({ code: 0, output: Buffer.from(output), fault: null });
const image = `sha256:${'a'.repeat(64)}`;
function fixture(overrides = {}) {
  const calls = [];
  const command = async (args, options) => {
    calls.push({ args, options });
    if (overrides[args[0]]) return overrides[args[0]](args, options);
    return args[0] === 'image'
      ? success(`${image} ${JSLUICE_VERSION} ${JSLUICE_PROTOCOL}`)
      : success();
  };
  return { calls, worker: new DockerWorker('local-fixture', 'owner-fixture', command) };
}
test('container runs pinned image with resource isolation and is removed before return', async () => {
  const { calls, worker } = fixture();
  assert.equal((await worker.run(input())).status, 'success');
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['image', 'create', 'start', 'rm', 'ps'],
  );
  const flags = calls[1].args;
  for (const flag of [
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=134217728',
    '--memory-swap=134217728',
    '--cpus=1',
    '--pids-limit=32',
    '--user=65532:65532',
    '--log-driver=none',
  ])
    assert.ok(flags.includes(flag), flag);
  assert.equal(flags.at(-1), image);
  assert.ok(!flags.includes('--volume'));
  assert.equal(calls[2].options.input.toString(), 'const x = 1;');
  assert.equal(calls[3].options.signal, undefined);
});
for (const fault of ['timeout', 'aborted', 'output_limit', 'spawn_error'])
  test(`${fault} discards output but always removes the container`, async () => {
    const { calls, worker } = fixture({
      start: () => ({ code: null, output: Buffer.from('sensitive partial data'), fault }),
    });
    const result = await worker.run(input());
    assert.equal(result.status, fault === 'timeout' ? 'timeout' : 'error');
    assert.equal(result.output.length, 0);
    assert.deepEqual(
      calls.slice(-2).map((c) => c.args[0]),
      ['rm', 'ps'],
    );
    assert.equal(worker.healthy, true);
  });
test('nonzero exit and unavailable image have explicit statuses', async () => {
  assert.equal(
    (await fixture({ start: () => ({ ...success(), code: 2 }) }).worker.run(input())).errorCode,
    'worker_failed',
  );
  const { calls, worker } = fixture({ image: () => ({ ...success(), code: 1 }) });
  assert.equal((await worker.run(input())).status, 'skipped');
  assert.equal(calls.length, 1);
});
test('unconfirmed removal and ambiguous creation poison the supervisor', async () => {
  for (const overrides of [
    { ps: () => success('deadbeef1234') },
    { ps: () => ({ ...success(), fault: 'timeout' }) },
    { create: () => ({ ...success(), fault: 'timeout' }) },
    {
      rm: () => {
        throw new Error('daemon disconnected');
      },
    },
  ]) {
    const { worker } = fixture(overrides);
    await assert.rejects(worker.run(input()), CleanupError);
    assert.equal(worker.healthy, false);
    await assert.rejects(worker.run(input()), CleanupError);
  }
});
test('restart recovery removes only containers bearing this store owner label', async () => {
  let listings = 0;
  const { calls, worker } = fixture({
    ps: () => success(listings++ === 0 ? 'deadbeef1234\n' : ''),
  });
  await worker.recover(1000);
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['ps', 'rm', 'ps'],
  );
  assert.ok(calls[0].args.includes('label=io.jsminer.owner=owner-fixture'));
  assert.equal(calls[1].args.at(-1), 'deadbeef1234');
  await assert.rejects(
    fixture({ ps: () => success('invalid id') }).worker.recover(1000),
    CleanupError,
  );
});

test('expired or cancelled setup never starts a new container or poisons the worker', async () => {
  for (const abort of [false, true]) {
    let now = 0;
    const controller = new AbortController();
    const calls = [];
    const command = async (args) => {
      calls.push(args[0]);
      if (abort) controller.abort();
      else now = 20;
      return success(`${image} ${JSLUICE_VERSION} ${JSLUICE_PROTOCOL}`);
    };
    const worker = new DockerWorker('fixture', 'owner', command, () => now);
    const result = await worker.run({ ...input(), timeoutMs: 10, signal: controller.signal });
    assert.equal(result.errorCode, abort ? 'aborted' : 'timeout');
    assert.deepEqual(calls, ['image']);
    assert.equal(worker.healthy, true);
  }
});

test('orphan recovery stops dispatching commands when its total budget is exhausted', async () => {
  let now = 0;
  const calls = [];
  const command = async (args) => {
    calls.push(args[0]);
    if (args[0] === 'ps') return success('aaaaaaaaaaaa\nbbbbbbbbbbbb\n');
    now = 10;
    return success();
  };
  const worker = new DockerWorker('fixture', 'owner', command, () => now);
  await assert.rejects(worker.recover(10), CleanupError);
  assert.deepEqual(calls, ['ps', 'rm']);
  assert.equal(worker.healthy, false);
});

test('a thrown create command is treated as uncertain creation', async () => {
  const { worker } = fixture({
    create: () => {
      throw new Error('fixture transport error');
    },
  });
  await assert.rejects(worker.run(input()), CleanupError);
  assert.equal(worker.healthy, false);
});

test('old worker protocol is refused before container creation', async () => {
  const { worker, calls } = fixture({ image: () => success(`${image} ${JSLUICE_VERSION} 1`) });
  assert.equal((await worker.run(input())).errorCode, 'tool_unavailable');
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['image'],
  );
});
