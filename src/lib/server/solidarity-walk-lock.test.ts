import { describe, it, expect, beforeEach } from 'vitest';
import { withSolidarityWalkLock, _resetWalkLockForTests } from './solidarity-walk-lock.js';

beforeEach(() => _resetWalkLockForTests());

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('withSolidarityWalkLock', () => {
	it('never runs two walks at the same time', async () => {
		let running = 0;
		let maxConcurrent = 0;
		const walk = () =>
			withSolidarityWalkLock(async () => {
				running++;
				maxConcurrent = Math.max(maxConcurrent, running);
				await tick();
				running--;
			});

		await Promise.all([walk(), walk(), walk()]);

		expect(maxConcurrent).toBe(1);
	});

	it('runs queued walks in the order they were requested', async () => {
		const order: number[] = [];
		const walk = (n: number) =>
			withSolidarityWalkLock(async () => {
				await tick();
				order.push(n);
			});

		await Promise.all([walk(1), walk(2), walk(3)]);

		expect(order).toEqual([1, 2, 3]);
	});

	it('returns each walk its own result', async () => {
		const [a, b] = await Promise.all([
			withSolidarityWalkLock(async () => 'first'),
			withSolidarityWalkLock(async () => 'second'),
		]);

		expect([a, b]).toEqual(['first', 'second']);
	});

	// A walk that dies must not wedge the queue for everything behind it.
	it('keeps the queue moving when a walk throws', async () => {
		const failing = withSolidarityWalkLock(async () => {
			throw new Error('rate limited');
		});

		await expect(failing).rejects.toThrow('rate limited');
		await expect(withSolidarityWalkLock(async () => 'after')).resolves.toBe('after');
	});

	it('propagates a failure only to the walk that caused it', async () => {
		const results = await Promise.allSettled([
			withSolidarityWalkLock(async () => {
				throw new Error('boom');
			}),
			withSolidarityWalkLock(async () => 'fine'),
		]);

		expect(results[0]!.status).toBe('rejected');
		expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'fine' });
	});
});
