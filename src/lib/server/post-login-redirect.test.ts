import { describe, it, expect } from 'vitest';
import {
	sanitizeRedirectTarget,
	isAdminOnlyPath,
	resolvePostLoginRedirect,
	loginRedirectPath,
} from './post-login-redirect.js';

describe('sanitizeRedirectTarget', () => {
	it('keeps a same-origin path with its query string', () => {
		expect(sanitizeRedirectTarget('/members?user=U123')).toBe('/members?user=U123');
		expect(sanitizeRedirectTarget('/')).toBe('/');
	});

	it('rejects absolute URLs to another origin', () => {
		expect(sanitizeRedirectTarget('https://evil.example/steal')).toBeNull();
		expect(sanitizeRedirectTarget('http://evil.example')).toBeNull();
	});

	it('rejects protocol-relative URLs, which browsers follow off-site', () => {
		expect(sanitizeRedirectTarget('//evil.example/steal')).toBeNull();
		expect(sanitizeRedirectTarget('/\\evil.example/steal')).toBeNull();
	});

	it('rejects non-rooted and scheme-bearing values', () => {
		expect(sanitizeRedirectTarget('members')).toBeNull();
		expect(sanitizeRedirectTarget('javascript:alert(1)')).toBeNull();
	});

	it('rejects values carrying control characters', () => {
		expect(sanitizeRedirectTarget('/pending\nLocation: https://evil.example')).toBeNull();
	});

	it('rejects the auth routes so login cannot loop', () => {
		expect(sanitizeRedirectTarget('/auth/slack')).toBeNull();
		expect(sanitizeRedirectTarget('/auth/dev-login')).toBeNull();
	});

	it('rejects empty, missing, and absurdly long values', () => {
		expect(sanitizeRedirectTarget(null)).toBeNull();
		expect(sanitizeRedirectTarget(undefined)).toBeNull();
		expect(sanitizeRedirectTarget('')).toBeNull();
		expect(sanitizeRedirectTarget('/' + 'a'.repeat(600))).toBeNull();
	});
});

describe('isAdminOnlyPath', () => {
	it('matches the admin pages and their sub-paths', () => {
		expect(isAdminOnlyPath('/pending')).toBe(true);
		expect(isAdminOnlyPath('/settings')).toBe(true);
		expect(isAdminOnlyPath('/members')).toBe(true);
		expect(isAdminOnlyPath('/members?user=U123')).toBe(true);
		expect(isAdminOnlyPath('/channel-chapter-diff')).toBe(true);
		expect(isAdminOnlyPath('/settings/deep/link')).toBe(true);
	});

	it('does not match pages that merely share a prefix', () => {
		expect(isAdminOnlyPath('/')).toBe(false);
		expect(isAdminOnlyPath('/pendingish')).toBe(false);
		expect(isAdminOnlyPath('/settings-export')).toBe(false);
	});
});

describe('resolvePostLoginRedirect', () => {
	it('returns the requested admin page for an admin', () => {
		expect(resolvePostLoginRedirect('/settings', { isAdmin: true })).toBe('/settings');
		expect(resolvePostLoginRedirect('/members?user=U123', { isAdmin: true })).toBe(
			'/members?user=U123',
		);
	});

	it('sends a non-admin who asked for an admin page to the root page', () => {
		expect(resolvePostLoginRedirect('/settings', { isAdmin: false })).toBe('/');
		expect(resolvePostLoginRedirect('/pending', { isAdmin: false })).toBe('/');
	});

	it('returns a non-admin page to everyone who asked for it', () => {
		expect(resolvePostLoginRedirect('/?days=30', { isAdmin: false })).toBe('/?days=30');
	});

	it('falls back to the root page when there is nothing safe to return to', () => {
		expect(resolvePostLoginRedirect(null, { isAdmin: true })).toBe('/');
		expect(resolvePostLoginRedirect('https://evil.example', { isAdmin: true })).toBe('/');
	});
});

describe('loginRedirectPath', () => {
	it('carries the requested page as an encoded query parameter', () => {
		expect(loginRedirectPath(new URL('http://app.test/members?user=U123'))).toBe(
			'/auth/slack?redirectTo=%2Fmembers%3Fuser%3DU123',
		);
	});

	it('leaves the login URL bare for the root page', () => {
		expect(loginRedirectPath(new URL('http://app.test/'))).toBe('/auth/slack');
	});

	it('keeps the root page query string, which the dashboard reads', () => {
		expect(loginRedirectPath(new URL('http://app.test/?days=30'))).toBe(
			'/auth/slack?redirectTo=%2F%3Fdays%3D30',
		);
	});
});
