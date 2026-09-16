// Constant-time comparison for secrets that arrive from a caller — the
// `?key=` / `?secret=` query parameters on the internal and webhook routes.
//
// Those secrets are compared rather than hashed, so the comparison is the only
// place a timing signal could appear. `webhook-token.ts` and `oauth-state.ts`
// already compare this way; this is the same discipline for the plain-secret
// routes, in one place so they cannot drift apart.

import { timingSafeEqual } from 'node:crypto';

/**
 * True when `provided` is exactly `expected`.
 *
 * Byte lengths rather than string lengths: timingSafeEqual throws on a length
 * mismatch, and a value carrying one multi-byte character is the same NUMBER of
 * characters as the secret but a different number of bytes.
 *
 * An unset `expected` never matches, so a missing secret cannot become an open
 * door for a caller who also sends nothing. Callers still check for the unset
 * case themselves and answer 500 — a misconfigured server should say so rather
 * than look like a rejected request.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
	if (!expected || provided === null || provided === undefined) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
