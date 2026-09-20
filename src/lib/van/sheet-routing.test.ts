import { describe, it, expect } from 'vitest';
import {
	matchSheetTarget,
	normaliseSheetKey,
	orderSheetTargets,
	type SheetTarget,
} from './sheet-routing.js';

// The region names here are the real shapes organizers cut — the same ones
// region-name.test.ts is built from. The spreadsheet names are the campaign's
// own: about a dozen "CR" sheets, and the two collisions they contain are the
// whole reason this module is a rule list rather than a lookup.

function target(prefix: string, label: string, spreadsheetId = `id-${label}`): SheetTarget {
	return { prefix, prefixKey: normaliseSheetKey(prefix), label, spreadsheetId };
}

/** The campaign's real configuration, in miniature. */
const TARGETS = orderSheetTargets([
	target('R01A_Alger', 'R01A_Alger CR'),
	target('R01A_Houghton', 'R01A_Houghton CR'),
	target('R09A', 'R09A_Detroit CR'),
	target('R10A', 'R10A_Dearborn CR'),
	target('R10C_Wayne_Taylor', 'R10C_Downriver CR'),
	target('R10C_Wayne_Wyandotte', 'R10C_Downriver CR'),
	target('R10C', 'R10C_WesternWayne CR'),
]);

describe('normaliseSheetKey', () => {
	it('folds the separators organizers actually mix', () => {
		expect(normaliseSheetKey('R08A.Macomb.WarrenCity')).toBe(
			normaliseSheetKey('R08A_Macomb_WarrenCity'),
		);
	});

	it('folds case', () => {
		expect(normaliseSheetKey('R10C')).toBe(normaliseSheetKey('r10c'));
	});

	it('keeps digits, which is what separates R10A from R10C', () => {
		expect(normaliseSheetKey('R10A')).not.toBe(normaliseSheetKey('R10C'));
	});

	it('is empty for a punctuation-only rule — the settings route refuses these', () => {
		expect(normaliseSheetKey('___...')).toBe('');
	});
});

describe('matchSheetTarget', () => {
	it('routes a region to the sheet whose code it carries', () => {
		expect(matchSheetTarget('R09A_Wayne_DetroitCityWd06Pct151_8_7', TARGETS)?.label).toBe(
			'R09A_Detroit CR',
		);
	});

	// The first collision: one region code, two counties, a sheet each. A rule
	// list keyed on the code alone would send both to whichever was entered
	// first.
	it('separates two counties that share a region code', () => {
		expect(matchSheetTarget('R01A_Alger_MunisingTwp001_9.11', TARGETS)?.label).toBe(
			'R01A_Alger CR',
		);
		expect(matchSheetTarget('R01A_Houghton_HancockCity002_9.11', TARGETS)?.label).toBe(
			'R01A_Houghton CR',
		);
	});

	// The second collision: one code AND one county, two sheets, separated only
	// by which cities each covers. This is what longest-match buys.
	it('prefers a city rule over the catch-all for the same code', () => {
		expect(matchSheetTarget('R10C_Wayne_TaylorCity004_9.11', TARGETS)?.label).toBe(
			'R10C_Downriver CR',
		);
		expect(matchSheetTarget('R10C_Wayne_WyandotteCity002_9.11', TARGETS)?.label).toBe(
			'R10C_Downriver CR',
		);
	});

	it('falls back to the catch-all for a city with no rule of its own', () => {
		expect(matchSheetTarget('R10C_Wayne_LivoniaCity007_9.11', TARGETS)?.label).toBe(
			'R10C_WesternWayne CR',
		);
	});

	it('matches a dot-separated name against an underscore-separated rule', () => {
		expect(matchSheetTarget('R10C.Wayne.TaylorCity004.9.11', TARGETS)?.label).toBe(
			'R10C_Downriver CR',
		);
	});

	it('returns null rather than guessing when no rule covers the region', () => {
		// A region in a part of the state nobody has configured a sheet for.
		// Guessing here would put a volunteer's name in another team's
		// spreadsheet, which looks exactly like a correct row.
		expect(matchSheetTarget('R04C_Livingston_BrightonCity003_9.11', TARGETS)).toBeNull();
	});

	it('returns null for an empty or missing region name', () => {
		expect(matchSheetTarget('', TARGETS)).toBeNull();
		expect(matchSheetTarget(null, TARGETS)).toBeNull();
		expect(matchSheetTarget(undefined, TARGETS)).toBeNull();
	});

	it('never lets a rule that normalises to nothing become a catch-all', () => {
		const withEmpty = orderSheetTargets([
			{ prefix: '...', prefixKey: '', label: 'junk', spreadsheetId: 'id-junk' },
		]);
		expect(matchSheetTarget('R09A_Wayne_DetroitCityWd06Pct151', withEmpty)).toBeNull();
	});
});

describe('orderSheetTargets', () => {
	it('puts the longest key first, which is what makes matching deterministic', () => {
		const ordered = orderSheetTargets([
			target('R10C', 'catch-all'),
			target('R10C_Wayne_Taylor', 'city'),
		]);
		expect(ordered[0]?.label).toBe('city');
	});

	it('does not mutate the list it was given', () => {
		const input = [target('R10C', 'catch-all'), target('R10C_Wayne_Taylor', 'city')];
		orderSheetTargets(input);
		expect(input[0]?.label).toBe('catch-all');
	});

	// The failure this ordering prevents, stated as a test so the requirement
	// survives a refactor of matchSheetTarget.
	it('an UNORDERED list routes to the shorter rule — why callers must not skip it', () => {
		const unordered = [target('R10C', 'catch-all'), target('R10C_Wayne_Taylor', 'city')];
		expect(matchSheetTarget('R10C_Wayne_TaylorCity004', unordered)?.label).toBe('catch-all');
		expect(matchSheetTarget('R10C_Wayne_TaylorCity004', orderSheetTargets(unordered))?.label).toBe(
			'city',
		);
	});
});
