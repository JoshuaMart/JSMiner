import { lookup } from 'node:dns/promises';
import { type ClientRequest, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ServiceConfig } from './config.ts';
import { ServiceError } from './errors.ts';

// Public unicast only. IPv6 transition/mapped ranges must not bypass IPv4 policy.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function validateScript(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ServiceError(422, 'invalid_content');
  }
  if (!text.trim() || /^\s*</u.test(text)) throw new ServiceError(422, 'invalid_content');
}

/** One authorized HTTP request. No redirects, cookies, proxy environment or ambient credentials. */
export async function capture(
  url: string,
  config: ServiceConfig,
  signal: AbortSignal,
  timeoutMs: number,
  resolveAddresses: (hostname: string) => Promise<{ address: string; family: number }[]> = (
    hostname,
  ) => lookup(hostname, { all: true, verbatim: true }),
): Promise<Buffer> {
  const deadline = performance.now() + timeoutMs;
  const target = new URL(url);
  const rule = config.capture.origins.find((r) => r.origin === target.origin);
  if (!rule || target.username || target.password || !['http:', 'https:'].includes(target.protocol))
    throw new ServiceError(403, 'destination_denied');
  const controller = new AbortController();
  const abort = () => controller.abort(new ServiceError(503, 'analysis_cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new ServiceError(504, 'capture_timeout')),
    Math.max(1, timeoutMs),
  );
  if (signal.aborted) abort();
  const active = controller.signal;
  // DNS resolution itself is not cancellable; race it without leaving a socket or rejection behind.
  const bounded = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const stop = () => reject(active.reason);
      operation.then(resolve, reject).finally(() => active.removeEventListener('abort', stop));
      if (active.aborted) reject(active.reason);
      else active.addEventListener('abort', stop, { once: true });
    });
  let request: ClientRequest | undefined;
  let closed: Promise<void> | undefined;
  let socket: Socket | undefined;
  let socketClosed: Promise<void> | undefined;
  let transfer: Promise<void> | undefined;
  const checkDeadline = () => {
    active.throwIfAborted();
    if (performance.now() >= deadline) throw new ServiceError(504, 'capture_timeout');
  };
  try {
    checkDeadline();
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await bounded(resolveAddresses(hostname));
    if (
      !addresses.length ||
      addresses.some(
        (a) =>
          !isIP(a.address) ||
          isIP(a.address) !== a.family ||
          (!rule.allow_private && !isPublicAddress(a.address)),
      )
    )
      throw new ServiceError(403, 'destination_denied');
    const address = addresses[0];
    if (!address) throw new ServiceError(403, 'destination_denied');
    checkDeadline();
    return await new Promise<Buffer>((resolve, reject) => {
      let receivedResponse = false;
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          agent: false,
          signal: active,
          maxHeaderSize: 16384,
          ...(target.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
          // Pin the validated address; keep the original hostname for Host and TLS verification.
          lookup: (_name, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          headers: {
            accept: 'application/javascript, text/javascript, */*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
          },
        },
        (response) => {
          receivedResponse = true;
          const fail = (error: ServiceError) => {
            reject(error);
            response.destroy();
            req.destroy();
          };
          if (response.statusCode !== 200) {
            fail(new ServiceError(502, 'capture_status'));
            return;
          }
          const mime =
            String(response.headers['content-type'] ?? '')
              .split(';')[0]
              ?.trim()
              .toLowerCase() ?? '';
          const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i
            .exec(String(response.headers['content-type'] ?? ''))?.[1]
            ?.toLowerCase();
          if (
            mime === 'text/html' ||
            mime.includes('xml') ||
            (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset))
          ) {
            fail(new ServiceError(422, 'invalid_content'));
            return;
          }
          const encoding = String(response.headers['content-encoding'] ?? 'identity')
            .trim()
            .toLowerCase();
          const decoder =
            encoding === 'gzip'
              ? createGunzip()
              : encoding === 'br'
                ? createBrotliDecompress()
                : encoding === 'deflate'
                  ? createInflate()
                  : null;
          if (!decoder && encoding !== 'identity') {
            fail(new ServiceError(502, 'capture_encoding'));
            return;
          }
          let wire = 0,
            decoded = 0;
          const chunks: Buffer[] = [];
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              wire += chunk.length;
              done(
                wire > config.capture.wire_bytes
                  ? new ServiceError(413, 'capture_too_large')
                  : null,
                chunk,
              );
            },
          });
          const sink = new Writable({
            write(chunk: Buffer, _encoding, done) {
              decoded += chunk.length;
              if (decoded > config.budgets.script_bytes) {
                done(new ServiceError(413, 'script_too_large'));
                return;
              }
              chunks.push(chunk);
              done();
            },
          });
          const streams = decoder ? [response, limiter, decoder, sink] : [response, limiter, sink];
          transfer = pipeline(streams, { signal: active }).then(() => {
            try {
              const bytes = Buffer.concat(chunks);
              validateScript(bytes);
              checkDeadline();
              resolve(bytes);
            } catch (error) {
              reject(error);
            }
          }, reject);
        },
      );
      request = req;
      closed = new Promise<void>((done) =>
        req.once('close', () => {
          if (!receivedResponse) reject(new ServiceError(502, 'capture_failed'));
          done();
        }),
      );
      req.once('socket', (connected) => {
        socket = connected;
        socketClosed = new Promise<void>((done) => connected.once('close', () => done()));
      });
      req.once('upgrade', (_response, upgraded) => {
        upgraded.destroy();
        reject(new ServiceError(502, 'capture_status'));
      });
      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, 'capture_failed');
  } finally {
    // Do not release the admission slot while a transfer or its socket is still closing.
    request?.destroy();
    socket?.destroy();
    await Promise.all([closed, socketClosed, transfer]);
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
