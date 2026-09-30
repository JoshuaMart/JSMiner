import { createHash, timingSafeEqual } from 'node:crypto';
import type { Permission } from '@jsminer/contracts';
import type { ServiceConfig } from './config.ts';

export interface Principal { projectId: string; permissions: readonly Permission[] }

export function createAuthenticator(tokens: ServiceConfig['tokens']) {
  const credentials = tokens.map(token => ({ digest: Buffer.from(token.sha256, 'hex'), projectId: token.project_id, permissions: [...token.permissions] }));
  return (authorization: string | undefined): Principal | null => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/i);
    if (!match?.[1]) return null;
    const digest = createHash('sha256').update(match[1]).digest();
    let principal: Principal | null = null;
    for (const candidate of credentials) {
      if (timingSafeEqual(candidate.digest, digest)) principal = { projectId: candidate.projectId, permissions: candidate.permissions };
    }
    return principal;
  };
}
