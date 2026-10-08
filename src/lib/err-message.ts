// Shared error-to-string helper, importable from both server modules and
// Svelte components (no $env/$lib/server imports).

/** The human-readable message of an unknown thrown value. */
export function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A thrown value's message with every `cause` under it. Drizzle wraps a
 *  driver error, so a constraint's name is on `cause`, not on the message. */
export function errChainText(err: unknown): string {
	const parts: string[] = [];
	for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
	return parts.join(' ');
}
