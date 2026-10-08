import { describe, it, expect } from 'vitest';
import { OUTSIDE_VOLUNTEER_TABLES, OutsideIdScrubber } from './replica-scrub.js';

const CHECKOUT = ['turf_id', 'slack_user_id', 'slack_user_name', 'claimed_at'];
const BLOCK = ['slack_user_id', 'display_name', 'reason', 'last_edited_by'];

describe('OutsideIdScrubber', () => {
	it('leaves a Slack member’s row exactly as it was', () => {
		const row = [7, 'U123', 'Dana', '2026-10-01'];
		expect(new OutsideIdScrubber().scrub(CHECKOUT, row)).toBe(row);
	});

	it('replaces an outside id and the name on its row', () => {
		const scrubber = new OutsideIdScrubber();
		expect(scrubber.scrub(CHECKOUT, [7, 'apple:001.abc', 'Ana Ruiz', '2026-10-01'])).toEqual([
			7,
			'apple:replica-1',
			'Apple volunteer 1',
			'2026-10-01',
		]);
		expect(scrubber.scrub(CHECKOUT, [8, 'google:1093', 'Bo', '2026-10-01'])).toEqual([
			8,
			'google:replica-1',
			'Google volunteer 1',
			'2026-10-01',
		]);
		expect(scrubber.count).toBe(2);
	});

	it('gives the same person the same stand-in in every table', () => {
		const scrubber = new OutsideIdScrubber();
		scrubber.scrub(CHECKOUT, [7, 'google:1', 'Ana', 'x']);
		scrubber.scrub(CHECKOUT, [8, 'google:2', 'Bo', 'x']);
		expect(scrubber.scrub(BLOCK, ['google:1', 'Ana', 'spam from ana@x.org', 'U_ADMIN'])).toEqual([
			'google:replica-1',
			'Google volunteer 1',
			null,
			'U_ADMIN',
		]);
		expect(scrubber.count).toBe(2);
	});

	it('replaces the name inside a checkout’s sheet_state too', () => {
		const columns = ['slack_user_id', 'slack_user_name', 'sheet_state'];
		const state = JSON.stringify({
			spreadsheetId: 'S1',
			cells: { Canvasser: 'Ana Ruiz', Status: 'Out' },
			prior: { Canvasser: '' },
		});
		const [, , scrubbed] = new OutsideIdScrubber().scrub(columns, [
			'apple:001.abc',
			'Ana Ruiz',
			state,
		]);
		expect(JSON.parse(scrubbed as string)).toEqual({
			spreadsheetId: 'S1',
			cells: { Canvasser: 'Apple volunteer 1', Status: 'Out' },
			prior: { Canvasser: '' },
		});
		expect(scrubbed).not.toContain('Ana');
	});

	it('replaces the name inside a checkout’s walk_in_state too', () => {
		const columns = ['slack_user_id', 'slack_user_name', 'walk_in_state'];
		const state = JSON.stringify({
			spreadsheetId: 'S1',
			rowIndex: 4,
			name: 'Ana Ruiz',
			day: '2026-09-19',
		});
		const [, , scrubbed] = new OutsideIdScrubber().scrub(columns, [
			'apple:001.abc',
			'Ana Ruiz',
			state,
		]);
		expect(JSON.parse(scrubbed as string)).toEqual({
			spreadsheetId: 'S1',
			rowIndex: 4,
			name: 'Apple volunteer 1',
			day: '2026-09-19',
		});
		expect(
			new OutsideIdScrubber().scrub(columns, ['google:1', 'Ana', '{not json Ana'])[2],
		).toBeNull();
	});

	// The app marks the names it writes into the sheet (`*Ana Ruiz`): the
	// name under the mark is replaced, and the mark kept.
	it('replaces a marked name in sheet_state and walk_in_state', () => {
		const columns = ['slack_user_id', 'slack_user_name', 'sheet_state', 'walk_in_state'];
		const [, , sheet, walkIn] = new OutsideIdScrubber().scrub(columns, [
			'apple:001.abc',
			'Ana Ruiz',
			JSON.stringify({ cells: { Canvasser: '*Ana Ruiz' } }),
			JSON.stringify({ spreadsheetId: 'S1', name: '*Ana Ruiz' }),
		]);
		expect(JSON.parse(sheet as string)).toEqual({ cells: { Canvasser: '*Apple volunteer 1' } });
		expect(JSON.parse(walkIn as string)).toEqual({
			spreadsheetId: 'S1',
			name: '*Apple volunteer 1',
		});
	});

	it('drops a sheet_state it cannot read rather than copy it blind', () => {
		const columns = ['slack_user_id', 'slack_user_name', 'sheet_state'];
		expect(
			new OutsideIdScrubber().scrub(columns, ['google:1', 'Ana', '{not json Ana'])[2],
		).toBeNull();
	});

	// Only the id columns say whose row it is.
	it('copies a Slack member’s row that merely mentions google: in free text', () => {
		const row = ['U123', 'Dana', 'google: duplicate account', 'U_ADMIN'];
		expect(new OutsideIdScrubber().scrub(BLOCK, row)).toBe(row);
	});

	describe('names learned up front', () => {
		function learned() {
			const scrubber = new OutsideIdScrubber();
			scrubber.learn('apple:001.abc', 'Ana Ruiz');
			scrubber.learn('google:1093', 'Bo Lee');
			scrubber.learn('U123', 'Slack Sam'); // not an outside id: ignored
			return scrubber;
		}

		it('replaces them in canvasser columns that carry no id', () => {
			const scrubber = learned();
			expect(scrubber.scrub(['turf_id', 'sheet_assigned_to'], [7, '  ana  RUIZ '])).toEqual([
				7,
				'Apple volunteer 1',
			]);
			expect(scrubber.scrub(['date', 'code', 'canvasser'], ['2026-10-01', 'C1', 'Bo Lee'])).toEqual(
				['2026-10-01', 'C1', 'Google volunteer 1'],
			);
		});

		// The shape MiniVAN really sends (van/catalog.ts canvasserName): first
		// and last name apart, no `name`.
		it('replaces them inside canvassers_json, first and last name together', () => {
			const scrubber = learned();
			const [scrubbed] = scrubber.scrub(
				['canvassers_json'],
				[
					JSON.stringify([
						{ canvassserId: 5, firstName: 'Ana', lastName: 'Ruiz' },
						{ canvassserId: 6, firstName: 'Slack', lastName: 'Sam' },
					]),
				],
			);
			expect(JSON.parse(scrubbed as string)).toEqual([
				{ canvassserId: 5, firstName: 'Apple', lastName: 'volunteer 1' },
				{ canvassserId: 6, firstName: 'Slack', lastName: 'Sam' },
			]);
			expect(scrubbed).not.toMatch(/Ana|Ruiz/);
		});

		it('replaces them in a VAN list of canvassers', () => {
			expect(
				learned().scrub(['turf_id', 'van_distributed_to'], [7, 'Slack Sam, Ana Ruiz, bo lee']),
			).toEqual([7, 'Slack Sam, Apple volunteer 1, Google volunteer 1']);
		});

		// The packet's Canvasser cell still named A when Slack member B claimed it.
		it('replaces them in another holder’s sheet_state', () => {
			const [, , state] = learned().scrub(
				['slack_user_id', 'slack_user_name', 'sheet_state'],
				[
					'U123',
					'Dana',
					JSON.stringify({ cells: { Canvasser: 'Dana' }, prior: { Canvasser: 'Ana Ruiz' } }),
				],
			);
			expect(JSON.parse(state as string)).toEqual({
				cells: { Canvasser: 'Dana' },
				prior: { Canvasser: 'Apple volunteer 1' },
			});
		});

		it('replaces them under the app’s mark, keeping the mark', () => {
			expect(learned().scrub(['turf_id', 'sheet_assigned_to'], [7, '*Ana Ruiz'])).toEqual([
				7,
				'*Apple volunteer 1',
			]);
		});

		it('still knows a name that itself starts with the mark', () => {
			const scrubber = new OutsideIdScrubber();
			scrubber.learn('apple:1', '*Ana');
			expect(scrubber.scrub(['canvasser'], ['*Ana'])).toEqual(['Apple volunteer 1']);
			expect(scrubber.scrub(['canvasser'], ['**Ana'])).toEqual(['*Apple volunteer 1']);
		});

		// One volunteer learned as just "Jane" must not cut another's full name
		// in half, leaving the real surname behind.
		it('matches MiniVAN names whole, never a part of one', () => {
			const scrubber = new OutsideIdScrubber();
			scrubber.learn('apple:1', 'Jane');
			scrubber.learn('apple:2', 'Jane Smith');
			const [scrubbed] = scrubber.scrub(
				['canvassers_json'],
				[
					JSON.stringify([
						{ canvassserId: 1, firstName: 'Jane', lastName: 'Smith' },
						{ canvassserId: 2, firstName: 'Jane', lastName: 'Okafor' },
					]),
				],
			);
			expect(JSON.parse(scrubbed as string)).toEqual([
				{ canvassserId: 1, firstName: 'Apple', lastName: 'volunteer 2' },
				{ canvassserId: 2, firstName: 'Jane', lastName: 'Okafor' },
			]);
		});

		// A stranger who calls themselves "taken" must not rewrite the app's own
		// markers, which the tracker reads back.
		it('touches only the Canvasser cells of sheet_state', () => {
			const scrubber = new OutsideIdScrubber();
			scrubber.learn('apple:1', 'taken');
			const state = {
				spreadsheetId: 'S1',
				told: 'taken',
				cells: { Canvasser: 'Dana', Status: 'taken' },
				prior: { Canvasser: 'taken' },
			};
			const [, scrubbed] = scrubber.scrub(
				['slack_user_id', 'sheet_state'],
				['U123', JSON.stringify(state)],
			);
			expect(JSON.parse(scrubbed as string)).toEqual({
				...state,
				prior: { Canvasser: 'Apple volunteer 1' },
			});
		});

		// Spec 013's placeholder belongs to every nameless volunteer at once.
		it('never learns a placeholder as somebody’s name', () => {
			const scrubber = new OutsideIdScrubber();
			scrubber.learn('google:1', 'Google volunteer');
			scrubber.learn('google:2', 'google  VOLUNTEER');
			scrubber.learn('apple:1', 'Apple volunteer');
			const row = [7, 'Google volunteer'];
			expect(scrubber.scrub(['turf_id', 'sheet_assigned_to'], row)).toBe(row);
			// Their ids still get stand-ins.
			expect(scrubber.count).toBe(3);
		});

		it('keeps an unreadable canvassers_json NOT NULL', () => {
			expect(learned().scrub(['canvassers_json'], ['{broken Ana Ruiz'])).toEqual(['[]']);
		});

		it('gives a learned volunteer the same stand-in when their own row comes later', () => {
			const scrubber = learned();
			expect(
				scrubber.scrub(['slack_user_id', 'slack_user_name'], ['apple:001.abc', 'Ana Ruiz']),
			).toEqual(['apple:replica-1', 'Apple volunteer 1']);
			expect(scrubber.count).toBe(2);
		});

		it('leaves other names, and every row when nothing was learned, as they were', () => {
			const row = [7, 'Slack Sam'];
			expect(learned().scrub(['turf_id', 'sheet_assigned_to'], row)).toBe(row);
			const json = ['[{"name":"Ana Ruiz"}]'];
			expect(new OutsideIdScrubber().scrub(['canvassers_json'], json)).toBe(json);
		});
	});

	it('leaves out the tables that only hold their details', () => {
		for (const t of ['outside_volunteers', 'google_volunteers', 'turf_notices']) {
			expect(OUTSIDE_VOLUNTEER_TABLES.has(t), t).toBe(true);
		}
	});
});
