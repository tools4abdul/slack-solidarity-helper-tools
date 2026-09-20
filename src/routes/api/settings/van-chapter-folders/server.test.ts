import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSave = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockSaveFolder = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({
	saveVanChapterFolders: mockSave,
	saveVanFolderChapters: mockSaveFolder,
	deleteVanChapterFolders: mockDelete,
}));

const authed = {
	locals: { session: { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U_VOL', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

const save = (over: Record<string, unknown> = {}) => ({
	action: 'save',
	chapterId: 71,
	chapterName: 'Middlesex County',
	folderIds: [1152, 1200],
	...over,
});

describe('POST /api/settings/van-chapter-folders', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSave.mockResolvedValue(undefined);
		mockDelete.mockResolvedValue(undefined);
		mockSaveFolder.mockResolvedValue(undefined);
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, save()) as never);
		expect(res.status).toBe(401);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, save()) as never);
		expect(res.status).toBe(403);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('saves a chapter’s folder list', async () => {
		const res = await POST(makeEvent(authed, save()) as never);
		expect(res.status).toBe(200);
		expect(mockSave).toHaveBeenCalledWith(
			{},
			{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152, 1200] },
			{ id: 'U_ADMIN', name: 'Alice' },
		);
	});

	// An empty list is meaningful: "this chapter has no turf".
	it('accepts an empty folder list', async () => {
		const res = await POST(makeEvent(authed, save({ folderIds: [] })) as never);
		expect(res.status).toBe(200);
		expect(mockSave).toHaveBeenCalled();
	});

	it('removes a chapter mapping', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', chapterId: 71 }) as never);
		expect(res.status).toBe(200);
		expect(mockDelete).toHaveBeenCalledWith({}, 71, { id: 'U_ADMIN', name: 'Alice' });
	});

	it('rejects non-integer and non-positive ids', async () => {
		for (const body of [
			save({ chapterId: 'seventy-one' }),
			save({ chapterId: 0 }),
			save({ folderIds: [1152, -3] }),
			save({ folderIds: [1152, 1.5] }),
			save({ folderIds: ['1152'] }),
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('rejects a missing chapter name and a non-array folder list', async () => {
		expect((await POST(makeEvent(authed, save({ chapterName: '  ' })) as never)).status).toBe(400);
		expect((await POST(makeEvent(authed, save({ folderIds: 1152 })) as never)).status).toBe(400);
	});

	it('caps how many folders one chapter can map to', async () => {
		const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
		const res = await POST(makeEvent(authed, save({ folderIds: tooMany })) as never);
		expect(res.status).toBe(400);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('rejects a bad action and malformed JSON', async () => {
		expect((await POST(makeEvent(authed, { action: 'nope', chapterId: 71 }) as never)).status).toBe(
			400,
		);
		const bad = {
			...authed,
			request: {
				json: async () => {
					throw new Error('bad json');
				},
			} as unknown as Request,
		};
		expect((await POST(bad as never)).status).toBe(400);
	});

	// The folder-first direction, used by /turfs/folder-map.
	describe('save-folder', () => {
		const saveFolder = (over: Record<string, unknown> = {}) => ({
			action: 'save-folder',
			folderId: 68299,
			chapters: [{ chapterId: 71, chapterName: 'Oakland County' }],
			...over,
		});

		it('saves one folder’s chapter list', async () => {
			const res = await POST(makeEvent(authed, saveFolder()) as never);
			expect(res.status).toBe(200);
			expect(mockSaveFolder).toHaveBeenCalledWith(
				{},
				{ folderId: 68299, chapters: [{ chapterId: 71, chapterName: 'Oakland County' }] },
				{ id: 'U_ADMIN', name: 'Alice' },
			);
			// Never the chapter-first writer: that one would wipe the chapter's
			// other folders.
			expect(mockSave).not.toHaveBeenCalled();
		});

		it('accepts an empty list, which unmaps the folder', async () => {
			const res = await POST(makeEvent(authed, saveFolder({ chapters: [] })) as never);
			expect(res.status).toBe(200);
			expect(mockSaveFolder).toHaveBeenCalledWith(
				{},
				{ folderId: 68299, chapters: [] },
				{ id: 'U_ADMIN', name: 'Alice' },
			);
		});

		it('trims chapter names and rejects empty or over-long ones', async () => {
			await POST(
				makeEvent(
					authed,
					saveFolder({ chapters: [{ chapterId: 71, chapterName: '  Oakland County  ' }] }),
				) as never,
			);
			expect(mockSaveFolder.mock.calls[0]![1].chapters[0].chapterName).toBe('Oakland County');

			for (const chapterName of ['', '   ', 'x'.repeat(201), 42]) {
				const res = await POST(
					makeEvent(authed, saveFolder({ chapters: [{ chapterId: 71, chapterName }] })) as never,
				);
				expect(res.status).toBe(400);
			}
			expect(mockSaveFolder).toHaveBeenCalledTimes(1);
		});

		it('rejects bad folder ids, chapter ids and a non-array', async () => {
			for (const folderId of [0, -1, 1.5, '68299', undefined]) {
				expect((await POST(makeEvent(authed, saveFolder({ folderId })) as never)).status).toBe(400);
			}
			for (const chapterId of [0, -1, 1.5, '71', undefined]) {
				const body = saveFolder({ chapters: [{ chapterId, chapterName: 'Oakland County' }] });
				expect((await POST(makeEvent(authed, body) as never)).status).toBe(400);
			}
			expect(
				(await POST(makeEvent(authed, saveFolder({ chapters: 'nope' })) as never)).status,
			).toBe(400);
			expect(mockSaveFolder).not.toHaveBeenCalled();
		});

		it('caps how many chapters one folder can map to', async () => {
			const chapters = Array.from({ length: 51 }, (_, i) => ({
				chapterId: i + 1,
				chapterName: `Chapter ${i + 1}`,
			}));
			const res = await POST(makeEvent(authed, saveFolder({ chapters })) as never);
			expect(res.status).toBe(400);
			expect(mockSaveFolder).not.toHaveBeenCalled();
		});

		it('still refuses a non-admin', async () => {
			const res = await POST(makeEvent(nonAdmin, saveFolder()) as never);
			expect(res.status).toBe(403);
			expect(mockSaveFolder).not.toHaveBeenCalled();
		});
	});
});
