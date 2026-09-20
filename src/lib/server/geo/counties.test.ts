import { describe, it, expect } from 'vitest';
import {
	countyIndexFor,
	inferCountyIndex,
	normaliseCountyName,
	parseCampaignStates,
} from './counties.js';

describe('normaliseCountyName', () => {
	it('drops the type suffix and everything that is not a letter or digit', () => {
		expect(normaliseCountyName('St. Clair County')).toBe('stclair');
		expect(normaliseCountyName('StClair')).toBe('stclair');
		expect(normaliseCountyName('Orleans Parish')).toBe('orleans');
		expect(normaliseCountyName('Aleutians East Borough')).toBe('aleutianseast');
	});
});

describe('countyIndexFor', () => {
	it('scopes to the states asked for', () => {
		const mi = countyIndexFor(['MI']);
		expect(mi.states).toEqual(['MI']);
		expect(mi.resolve('Wayne')?.state).toBe('MI');
		// Chatham is a GA county; it is not in an MI index.
		expect(mi.resolve('Chatham')).toBeNull();
	});

	it('resolves a county written run together with its place', () => {
		expect(countyIndexFor(['MI']).resolve('OaklandBerkleyCity002')?.shortName).toBe('Oakland');
	});

	it('refuses a name several states in scope could claim', () => {
		// 31 states have a Washington County, so nationally it means nothing —
		// an unplaced region beats a dot in the wrong state.
		expect(countyIndexFor([]).resolve('Washington')).toBeNull();
		// Scoped to one state it is unambiguous again.
		expect(countyIndexFor(['MI']).resolve('Washtenaw')?.shortName).toBe('Washtenaw');
	});

	it('covers every state, not one', () => {
		expect(countyIndexFor(['GA']).resolve('DeKalb')?.state).toBe('GA');
		expect(countyIndexFor(['TX']).resolve('Harris')?.state).toBe('TX');
		expect(countyIndexFor(['LA']).resolve('Orleans')?.state).toBe('LA');
		expect(countyIndexFor([]).entries.length).toBeGreaterThan(3000);
	});
});

describe('inferCountyIndex', () => {
	it('works out the state from the names themselves', () => {
		// Real region segments from one state's catalog, no configuration.
		const index = inferCountyIndex(['Livingston', 'Washtenaw', 'Kalamazoo', 'Oakland', 'Kent']);
		expect(index.states).toEqual(['MI']);
		// And then reads a name inside that state that is ambiguous nationally —
		// 24 states have a Jackson County, and the inferred one is among them.
		expect(countyIndexFor([]).resolve('Jackson')).toBeNull();
		expect(index.resolve('Jackson')?.state).toBe('MI');
	});

	it('follows the data to a different state', () => {
		const index = inferCountyIndex(['Chatham', 'Gwinnett', 'Cobb', 'Fulton']);
		expect(index.states).toEqual(['GA']);
	});

	it('keeps a genuine second state and drops a stray name', () => {
		const names = [
			...Array.from({ length: 20 }, () => 'Washtenaw'),
			...Array.from({ length: 12 }, () => 'Gwinnett'),
			'Maricopa',
		];
		const index = inferCountyIndex(names);
		expect(index.states).toEqual(['MI', 'GA']);
		expect(index.resolve('Maricopa')).toBeNull();
	});

	it('falls back to every state when nothing resolves', () => {
		const index = inferCountyIndex(['9', '11', 'Turf 01']);
		expect(index.entries.length).toBeGreaterThan(3000);
	});
});

describe('parseCampaignStates', () => {
	it('takes a comma-separated list, in any case, ignoring junk', () => {
		expect(parseCampaignStates('mi, oh')).toEqual(['MI', 'OH']);
		expect(parseCampaignStates('MI')).toEqual(['MI']);
		expect(parseCampaignStates('Mich., MI')).toEqual(['MI']);
		expect(parseCampaignStates(undefined)).toEqual([]);
		expect(parseCampaignStates('')).toEqual([]);
	});
});
