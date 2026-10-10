import { describe, it, expect } from 'vitest';
import { extractSpreadsheetId, isSpreadsheetId } from './google-sheet-id.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';

describe('extractSpreadsheetId', () => {
	it('takes the id out of a Sheets URL, or returns the text trimmed', () => {
		expect(extractSpreadsheetId(` https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0 `)).toBe(
			ID,
		);
		expect(extractSpreadsheetId(`  ${ID}  `)).toBe(ID);
	});
});

describe('isSpreadsheetId', () => {
	it('accepts the shape of an id and nothing else', () => {
		expect(isSpreadsheetId(ID)).toBe(true);
		expect(isSpreadsheetId('short')).toBe(false);
		expect(isSpreadsheetId('my spreadsheet name here')).toBe(false);
		expect(isSpreadsheetId('a'.repeat(201))).toBe(false);
	});
});
