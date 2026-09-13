import { describe, it, expect } from 'vitest';
import { describeAge, oldestRefreshMinutes } from './turf-freshness.js';

const turf = (refreshedMinutesAgo: number | null) => ({ refreshedMinutesAgo });

describe('oldestRefreshMinutes', () => {
	it('quotes the worst age on the page, not the first row or the best', () => {
		// The label stands for every count in the list, so the freshest one is the
		// dishonest answer — it promises data the rest of the page does not have.
		expect(oldestRefreshMinutes([turf(12), turf(2880), turf(45)])).toBe(2880);
	});

	it('ignores turf VAN has never given a refresh time for', () => {
		expect(oldestRefreshMinutes([turf(null), turf(30), turf(null)])).toBe(30);
	});

	it('is null when nothing on the page has an age at all', () => {
		// Distinct from zero, which would read as "just now".
		expect(oldestRefreshMinutes([turf(null)])).toBeNull();
		expect(oldestRefreshMinutes([])).toBeNull();
	});
});

describe('describeAge', () => {
	it.each([
		[0, '0 minutes ago'],
		[1, '1 minute ago'],
		[59, '59 minutes ago'],
		[60, '1 hour ago'],
		[150, '3 hours ago'],
		[47 * 60, '47 hours ago'],
	])('renders %i minutes as %s', (minutes, expected) => {
		expect(describeAge(minutes)).toBe(expected);
	});

	it('rolls up to days past two, so nobody has to divide 72 hours in their head', () => {
		expect(describeAge(48 * 60)).toBe('2 days ago');
		expect(describeAge(72 * 60)).toBe('3 days ago');
	});

	it('says an unknown age out loud rather than implying freshness', () => {
		expect(describeAge(null)).toBe('an unknown time');
	});
});
