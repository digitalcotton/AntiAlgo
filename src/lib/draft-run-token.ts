/**
 * draft-run-token.ts: the signed hand-off between the job-draft POST and the
 * per-document run endpoint. Pure: no I/O, no clock of its own.
 *
 * WHY A TOKEN AT ALL. The run endpoint (src/pages/desk/job-draft/[slug]/run.ts)
 * is reached server-to-server, with no session cookie, so a viewer cannot be
 * resolved for it and middleware lets it through as signed-out. The only thing
 * standing between "anyone on the internet" and "render this row with this
 * person's key" is this signature. The secret is a server-only environment
 * variable (DRAFT_RUN_SECRET), and the payload it signs names everything the
 * render needs: which row, whose, which posting, which document, which
 * provider, and the person's own note.
 *
 * WHY THE NOTE RIDES IN THE TOKEN. The "why this company" reason is the person's
 * own text, capped at 600 characters at the POST, with no reader outside the
 * render and no column of its own. Carrying it here keeps it in memory for
 * the one hop it has to make and stores it nowhere new. The person's steer for
 * a regenerate (draft-steer.ts) rides the same way and for the same reason:
 * small structured data (a few allowlisted chips and a capped note) whose only
 * job is to shape this one render, stored nowhere and gone once it lands.
 *
 * SHORT LIVED. A token is good for one minute: long enough for the dispatch
 * fetch, far too short to be worth stealing from a log. Replay past that
 * window is refused by the expiry; replay inside it is made harmless by the
 * row claim in the run endpoint (a claimed row is not rendered twice).
 *
 * CONSTANT TIME. The signature check compares with timingSafeEqual after a
 * length check, the same guard src/lib/password.ts keeps: timingSafeEqual
 * throws on a length mismatch, and a thrown error out of a verifier is the
 * one failure a verifier must never produce.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PROVIDERS, type Provider } from './keychain';
import type { RenderKind } from './generated-render-store';
import type { DraftSteer } from './draft-steer';

export const RUN_TOKEN_TTL_MS = 60_000;

export interface RunPayload {
  readonly v: 1;
  readonly renderId: string;
  readonly userId: string;
  readonly jobId: string;
  readonly kind: RenderKind;
  readonly provider: Provider | null;
  readonly reason: string | null;
  /** The person's steer for this one regenerate, or null/absent for a first
      draft or a plain re-draft (draft-steer.ts). Ephemeral like `reason`. */
  readonly steer?: DraftSteer | null;
  /** Unix milliseconds after which the token is refused. */
  readonly exp: number;
}

/** DRAFT_RUN_SECRET, read at first use and never at import (the same lazy
    posture keychain.ts takes with its master secret: the build must never need
    it). null when unset, which the dispatcher reads as "render in-process". */
export function draftRunSecret(): string | null {
  const value = process.env.DRAFT_RUN_SECRET;
  return value && value.trim().length > 0 ? value : null;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signRunToken(payload: RunPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function isKind(value: unknown): value is RenderKind {
  return value === 'resume' || value === 'cover';
}

function isProvider(value: unknown): value is Provider | null {
  return value === null || (typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value));
}

/** A steer off the wire, coerced to a DraftSteer or dropped to null. Validated
    loosely on purpose: it is small structured data our own signRunToken minted,
    so this only guards the SHAPE (chips an array of strings, note a string or
    null) against a corrupted or hand-crafted payload, and drops anything that
    does not fit rather than rejecting the whole token. The chip ids are not
    re-checked against STEER_CHIPS here (parseSteer already allowlisted them at
    the POST, and steerGuidance ignores any id it does not know), so a stray id
    is harmless. Absent or null steer stays null: a plain re-draft. */
function sanitizeSteer(value: unknown): DraftSteer | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.chips) || !s.chips.every((c) => typeof c === 'string')) return null;
  if (s.note !== null && typeof s.note !== 'string') return null;
  return { chips: s.chips as DraftSteer['chips'], note: (s.note as string | null) ?? null };
}

/** The payload a token carries, or null for anything not signed by `secret`,
    expired at `nowMs`, or not shaped like a RunPayload. Never throws. */
export function verifyRunToken(token: string, secret: string, nowMs: number): RunPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(encoded, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.renderId !== 'string' || typeof p.userId !== 'string' || typeof p.jobId !== 'string') return null;
  if (!isKind(p.kind) || !isProvider(p.provider)) return null;
  if (p.reason !== null && typeof p.reason !== 'string') return null;
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= nowMs) return null;

  return {
    v: 1,
    renderId: p.renderId,
    userId: p.userId,
    jobId: p.jobId,
    kind: p.kind,
    provider: p.provider,
    reason: p.reason,
    // Dropped to null when malformed, never a reason to reject the token: an
    // unusable steer just means this render is not steered.
    steer: sanitizeSteer(p.steer),
    exp: p.exp
  };
}
