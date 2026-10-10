// A Google Sheets id out of what an admin pastes — usually the whole URL. Pure,
// so the settings page can show a link to the sheet it saved and the server can
// validate with the same rule (app-config-fields.ts).

/** What a spreadsheet id looks like in a Sheets URL. A shape check, not an
 *  existence check. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/;
/** Google's ids are 44 chars today; the cap is loose because the length is
 *  not documented as stable and a too-tight check would reject a valid sheet. */
const MAX_SPREADSHEET_ID_LENGTH = 200;

/** The id in a Sheets URL, or the text itself when it is not one; trimmed. */
export function extractSpreadsheetId(raw: string): string {
	const text = raw.trim();
	return (text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? text).trim();
}

/** Whether `id` has the shape of a Sheets id. */
export function isSpreadsheetId(id: string): boolean {
	return id.length <= MAX_SPREADSHEET_ID_LENGTH && SPREADSHEET_ID.test(id);
}
