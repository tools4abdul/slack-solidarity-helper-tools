import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockSaveUserToken = vi.hoisted(() => vi.fn());
const mockDeleteUserToken = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({
	sessionStore: { set: mockSessionSet },
	db: {},
}));

vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));

vi.mock('$lib/server/slack', () => ({ slack: { users: { info: mockUsersInfo } } }));

vi.mock('$lib/server/user-tokens', () => ({
	saveUserToken: mockSaveUserToken,
	deleteUserToken: mockDeleteUserToken,
}));

vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	SLACK_CLIENT_SECRET: 'client-secret',
	SLACK_SUPERUSER_ID: 'USUPER',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));

vi.mock('$app/environment', () => ({ dev: true }));

import { GET } from './+server.js';
import { signState } from '$lib/server/oauth-state.js';

function jsonRes(body: unknown): Response {
	return { json: async () => body } as never;
}

interface EventOpts {
	code?: string;
	/** Overrides the signed state entirely — for tampered/legacy state tests. */
	rawState?: string;
	/** Overrides the nonce the cookie holds; defaults to the one just signed. */
	cookieState?: string;
	/** Drops the state cookie, as a browser handoff does. */
	noStateCookie?: boolean;
	/** Destination baked into the *signed* state. */
	stateDestination?: string | null;
	/** Marks the attempt as the one automatic retry. */
	isRetry?: boolean;
	/** Destination in the oauth_redirect *cookie*. */
	redirectTo?: string;
}

function makeEvent(opts: EventOpts = {}) {
	const code = opts.code ?? 'CODE';
	const { state, nonce } = signState({
		destination: opts.stateDestination ?? null,
		isRetry: opts.isRetry ?? false,
	});
	const jar: Record<string, string | undefined> = {
		oauth_state: opts.noStateCookie ? undefined : (opts.cookieState ?? nonce),
		oauth_redirect: opts.redirectTo,
	};
	const url = new URL('http://localhost/auth/slack/callback');
	url.searchParams.set('code', code);
	url.searchParams.set('state', opts.rawState ?? state);
	return {
		url,
		cookies: {
			get: vi.fn((name: string) => jar[name]),
			set: vi.fn(),
			delete: vi.fn(),
		},
	};
}

const SETTINGS = {
	allowedSlackUserIds: new Set(['UADMIN']),
	moderatorSlackUserIds: new Set(['UMOD']),
};

function mockSuccessfulOAuth(userId: string, userName: string, scope = 'chat:write'): void {
	// A single call — the user id comes off the token response itself, so there
	// is no users.identity round trip to stub.
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(
				jsonRes({ ok: true, authed_user: { id: userId, access_token: 'tok', scope } }),
			),
	);
	mockUsersInfo.mockResolvedValue({ ok: true, user: { name: userName } });
}

describe('GET /auth/slack/callback', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it('admin path: creates session with isAdmin: true and redirects to /', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UADMIN',
			slackUserName: 'Admin User',
			isAdmin: true,
			isModerator: false,
		});
	});

	it('non-admin path: creates session with isAdmin: false and redirects to /', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UNORMAL',
			slackUserName: 'Bob',
			isAdmin: false,
			isModerator: false,
		});
	});

	it('superuser is admin even when absent from the allowed list', async () => {
		mockSuccessfulOAuth('USUPER', 'Root');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'USUPER',
			slackUserName: 'Root',
			isAdmin: true,
			isModerator: false,
		});
	});

	it('superuser is admin even when loadSettings rejects (lockout escape hatch)', async () => {
		mockLoadSettings.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('USUPER', 'Root');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true });
	});

	it('non-superuser is denied admin (not 500) when loadSettings rejects', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: false });
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('[auth] loadSettings failed'),
			expect.anything(),
		);
		errorSpy.mockRestore();
	});

	it('moderator path: isModerator true, isAdmin false', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302, location: '/' });

		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UMOD',
			slackUserName: 'Mo',
			isAdmin: false,
			isModerator: true,
		});
	});

	// isModerator means "moderator and nothing more"; an admin never carries it.
	it('someone on both lists is an admin, not a moderator', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['UBOTH']),
			moderatorSlackUserIds: new Set(['UBOTH']),
		});
		mockSuccessfulOAuth('UBOTH', 'Both');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true, isModerator: false });
	});

	it('sends a moderator back to the member page they asked for', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(
			GET(makeEvent({ redirectTo: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});

	it('does not send a moderator to an admin page', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(GET(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});
	});

	it('admin gate reads the settings allowed list (DB-backed with env fallback)', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['UFROMDB']),
			moderatorSlackUserIds: new Set(),
		});
		mockSuccessfulOAuth('UFROMDB', 'Dana');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true });
	});

	it('does not log [auth] blocked user warning for legitimate non-admin sign-in', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		const blockedUserCalls = warnSpy.mock.calls.filter((args: unknown[]) =>
			args.some((arg) => typeof arg === 'string' && arg.includes('blocked user')),
		);
		expect(blockedUserCalls).toEqual([]);
	});

	it('logs successful login with admin status', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringMatching(/\[auth] login: Admin User \(UADMIN\) admin=true/),
		);
	});

	it('returns an admin to the page they originally requested', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(
			GET(makeEvent({ redirectTo: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});

	it('sends a non-admin who requested an admin page to /', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});
	});

	it('ignores an off-site redirect cookie', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(
			GET(makeEvent({ redirectTo: '//evil.example/steal' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/' });
	});

	it('clears the redirect cookie once it has been consumed', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');
		const event = makeEvent({ redirectTo: '/settings' });

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});

	it('rejects with 400 on OAuth state mismatch (preserved behavior)', async () => {
		await expect(
			GET(makeEvent({ cookieState: 'a-different-nonce' }) as never),
		).rejects.toMatchObject({ status: 400 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('rejects with 502 when Slack token exchange fails (preserved behavior)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(jsonRes({ ok: false, error: 'invalid_code' })),
		);

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});
});

// The user token is what lets the admin-defined info commands post as a real
// person instead of as the bot (see user-tokens.ts).
describe('GET /auth/slack/callback — user token capture', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it("stores an admin's token with the scopes Slack granted", async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(expect.anything(), {
			slackUserId: 'UADMIN',
			accessToken: 'tok',
			scopes: 'chat:write',
		});
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
	});

	// Info commands post as whoever runs them, and moderators may run them.
	it("stores a moderator's token too", async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ slackUserId: 'UMOD' }),
		);
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
	});

	it('clears any stored token for a non-admin instead of keeping it', async () => {
		// Holding a credential the app has no use for is the thing to avoid —
		// this also cleans up after someone is dropped from the allowlist.
		mockSuccessfulOAuth('URANDOM', 'Random User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).not.toHaveBeenCalled();
		expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'URANDOM');
	});

	it('records an empty scope string when Slack omits one', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User', '');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ scopes: '' }),
		);
	});

	it('still logs the admin in when storing the token fails', async () => {
		// The session is the point of this route; the info commands degrade to
		// "authorize again" on their own.
		mockSaveUserToken.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
	});
});

// The failure this recovers from: a link tapped in Slack's in-app webview and
// then reopened in Safari. The URL (and so the state) crosses over; the cookie
// jar does not. Before this, every one of those landed on a bare 400.
describe('GET /auth/slack/callback — recovering a login that lost its cookie', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('restarts the login instead of 400ing when the state cookie is missing', async () => {
		await expect(GET(makeEvent({ noStateCookie: true }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?retry=1',
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('carries the signed destination into the restart, since the cookie is gone too', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, stateDestination: '/members?user=U123' }) as never),
		).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?redirectTo=%2Fmembers%3Fuser%3DU123&retry=1',
		});
	});

	it('never restarts to an off-site destination', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, stateDestination: '//evil.example/steal' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack?retry=1' });
	});

	it('gives up with an explanation rather than looping when the retry lost it too', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, isRetry: true }) as never),
		).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringContaining('did not send back the login cookie') },
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('restarts a login that sat on the Slack approval screen past the TTL', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const event = makeEvent();
		vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?retry=1',
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	// The bare UUIDs the previous implementation minted. Only the handful in
	// flight during a deploy ever hit this, and they should not eat a 400.
	it('restarts on a legacy unsigned state instead of rejecting it', async () => {
		await expect(
			GET(makeEvent({ rawState: '550e8400-e29b-41d4-a716-446655440000' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack?retry=1' });
	});

	it('rejects — does not restart — a state whose payload was rewritten', async () => {
		const { state, nonce } = signState({ destination: '/', isRetry: false });
		const [payload, signature] = state.split('.');
		const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		forged.d = '/settings';
		const rawState = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;

		await expect(GET(makeEvent({ rawState, cookieState: nonce }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('falls back to the signed destination when only the redirect cookie is missing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonRes({
					ok: true,
					authed_user: { id: 'UADMIN', access_token: 'tok', scope: 'chat:write' },
				}),
			),
		);
		mockSaveUserToken.mockResolvedValue(undefined);

		await expect(
			GET(makeEvent({ stateDestination: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});
});
