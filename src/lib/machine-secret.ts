/**
 * machine-secret.ts: the one shared secret between this site and the Mac mini.
 *
 * The mini never holds a database credential and never learns who a person
 * is. What it holds is this one string, set on the mini in ~/.jobmachine-fetch
 * and on Vercel as MACHINE_FETCH_SECRET, and it sends it as a Bearer token on
 * the two machine routes (src/pages/machine/posting-fetch/claim.ts and
 * result.ts). Compared in constant time, the same way draft-run-token.ts
 * compares its signatures. Unset means the routes answer 503: a deployment
 * without the secret has no machine, and nothing should pretend otherwise.
 */
import { timingSafeEqual } from 'node:crypto';

export function machineFetchSecret(): string | null {
  const value = process.env.MACHINE_FETCH_SECRET;
  return value && value.trim().length > 0 ? value.trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 'ok' when the Bearer matches; 'unset' when this deployment has no secret;
    'mismatch' otherwise. The caller turns these into 200, 503 and 401. */
export function machineRequestAuth(request: Request): 'ok' | 'unset' | 'mismatch' {
  const secret = machineFetchSecret();
  if (!secret) return 'unset';
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return presented && safeEqual(presented, secret) ? 'ok' : 'mismatch';
}
