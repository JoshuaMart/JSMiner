// Ordered, bounded frames; output is flushed after each complete module.
export async function* readBatch() {
  let parts = [],
    total = 0,
    index = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 128 * 1024 * 1024) throw new Error();
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      if (end < 0) {
        parts.push(chunk.subarray(start));
        break;
      }
      parts.push(chunk.subarray(start, end));
      const item = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
      );
      parts = [];
      start = end + 1;
      if (
        !item ||
        Object.keys(item).sort().join(',') !== 'index,input' ||
        item.index !== index ||
        index >= 2000 ||
        typeof item.input !== 'string'
      )
        throw new Error();
      const bytes = Buffer.from(item.input, 'base64');
      if (bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== item.input)
        throw new Error();
      yield { index: index++, bytes };
    }
  }
  if (parts.length) throw new Error();
}
export async function writeResult(index, output, error = null) {
  const line = `${JSON.stringify({ index, output: output === null ? null : Buffer.from(JSON.stringify(output)).toString('base64'), error })}\n`;
  await new Promise((resolve, reject) =>
    process.stdout.write(line, (err) => (err ? reject(err) : resolve())),
  );
}
export async function runBatch(analyze) {
  for await (const { index, bytes } of readBatch()) {
    let result;
    try {
      result = await analyze(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      await writeResult(index, null, 'worker_failed');
      continue;
    }
    await writeResult(index, result);
  }
}
