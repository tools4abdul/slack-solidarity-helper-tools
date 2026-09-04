import { describe, expect, it } from 'vitest';
import { countyForZip } from './michigan-zip-counties.js';

describe('countyForZip', () => {
	it('resolves known Michigan zips to their county', () => {
		expect(countyForZip('48201')).toBe('Wayne');
		expect(countyForZip('49503')).toBe('Kent');
		expect(countyForZip('48933')).toBe('Ingham');
	});

	it('trims whitespace and zip+4 suffixes', () => {
		expect(countyForZip(' 48201 ')).toBe('Wayne');
		expect(countyForZip('48201-1234')).toBe('Wayne');
	});

	it('returns null for unknown or non-Michigan zips', () => {
		expect(countyForZip('90210')).toBeNull();
		expect(countyForZip('00000')).toBeNull();
		expect(countyForZip(null)).toBeNull();
		expect(countyForZip(undefined)).toBeNull();
		expect(countyForZip('')).toBeNull();
	});
});
