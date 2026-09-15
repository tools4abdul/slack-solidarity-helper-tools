import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchPaginated, fetchWithRetry } from './solidarity-paginate.js';

function rateLimited(retryAfter = '0') {
	return {
		ok: false,
		status: 429,
		headers: new Headers({ 'Retry-After': retryAfter }),
		json: async () => ({}),
		text: async () => 'rate limited',
	} as unknown as Response;
}

function statusResponse(status: number, ok: boolean) {
	return {
		ok,
		status,
		headers: new Headers(),
		json: async () => ({ data: [] }),
		text: async () => 'body',
	} as unknown as Response;
}

describe('fetchWithRetry', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns a non-429 success response without retrying', async () => {
		fetchMock.mockResolvedValueOnce(statusResponse(200, true));

		const res = await fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns a non-429 error response as-is — callers check res.ok themselves', async () => {
		fetchMock.mockResolvedValueOnce(statusResponse(500, false));

		const res = await fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});

		expect(res.status).toBe(500);
		expect(res.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('gives up once the budget is spent rather than retrying forever', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValue(rateLimited());

		await expect(
			fetchWithRetry('https://example.test', {}, 'thing', 'tag', { retriesUsed: 0 }),
		).rejects.toThrow(/retry budget exhausted/);

		// One initial call plus MAX_RETRIES.
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it('honors a named Retry-After as sent rather than escalating past it', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
		fetchMock.mockResolvedValue(rateLimited('2'));

		const attempt = fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});
		const settled = expect(attempt).rejects.toThrow(/retry budget exhausted/);
		await vi.runAllTimersAsync();
		await settled;

		expect(sleepSpy.mock.calls.map((c) => c[1])).toEqual([2000, 2000, 2000, 2000, 2000]);
		vi.useRealTimers();
	});

	it('escalates the invented delay when no Retry-After is sent, capped in minutes', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
		// No Retry-After header: the escalation is the only thing setting the wait.
		fetchMock.mockResolvedValue({
			ok: false,
			status: 429,
			headers: new Headers(),
			json: async () => ({}),
			text: async () => 'rate limited',
		} as unknown as Response);

		const attempt = fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});
		const settled = expect(attempt).rejects.toThrow(/retry budget exhausted/);
		await vi.runAllTimersAsync();
		await settled;

		const waits = sleepSpy.mock.calls.map((c) => c[1]);
		expect(waits).toEqual([30_000, 60_000, 60_000, 60_000, 60_000]);
		vi.useRealTimers();
	});
});

describe('fetchPaginated', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function page(items: unknown[]) {
		return {
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ data: items }),
		} as unknown as Response;
	}

	it('carries the retry budget across pages instead of resetting it per page (FR-004a)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));

		fetchMock
			// page 0: three 429s, then a full page — spends 3 of the 5-retry budget.
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(page(fullPage))
			// page 1: only 2 retries remain in the shared budget, so the third
			// 429 here exhausts it — even though page 1 alone has only seen 3.
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(fetchPaginated('token', '/v1/users', '/v1/users')).rejects.toThrow(
			/retry budget exhausted/,
		);

		// 4 calls for page 0 + 3 for page 1 = 7. A budget reset per page (the
		// FR-004a bug this guards against) would instead take 4 + 6 = 10.
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});
});

describe('fetchPaginated pacing', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function page(items: unknown[]) {
		return {
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ data: items }),
			text: async () => '',
		} as unknown as Response;
	}

	const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));

	it('does not sleep when paceMs is omitted (unchanged for existing callers)', async () => {
		vi.useFakeTimers();
		const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
		fetchMock.mockResolvedValueOnce(page(fullPage)).mockResolvedValueOnce(page([{ id: 999 }]));

		await fetchPaginated('tok', '/v1/things', 'things');

		expect(sleepSpy).not.toHaveBeenCalled();
	});

	it('sleeps between pages when paced, but not before the first', async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(page(fullPage))
			.mockResolvedValueOnce(page(fullPage))
			.mockResolvedValueOnce(page([{ id: 999 }]));

		const walk = fetchPaginated('tok', '/v1/things', 'things', '', 'tag', 600);
		await vi.runAllTimersAsync();
		const items = await walk;

		expect(items).toHaveLength(201);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('paces a single-page walk without any delay', async () => {
		vi.useFakeTimers();
		const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
		fetchMock.mockResolvedValueOnce(page([{ id: 1 }]));

		await fetchPaginated('tok', '/v1/things', 'things', '', 'tag', 600);

		expect(sleepSpy).not.toHaveBeenCalled();
	});
});
