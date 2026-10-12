import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	isCursorAgentChatConversationEstablished,
	listCursorAgentChatsInWorkingDirectoryBucket,
	resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory,
	resolveCursorAgentChatStoreRootDirectoryPath,
} from "../../../src/terminal/cursor-agent-chat-store-location-and-conversation-inspection";

let temporaryDirectoryPath: string | null = null;

afterEach(() => {
	if (temporaryDirectoryPath) rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	temporaryDirectoryPath = null;
});

describe("resolveCursorAgentChatStoreRootDirectoryPath", () => {
	it("follows cursor-agent's own precedence: CURSOR_CONFIG_DIR, then XDG_CONFIG_HOME/cursor, then ~/.cursor", () => {
		expect(
			resolveCursorAgentChatStoreRootDirectoryPath({ CURSOR_CONFIG_DIR: "/config", XDG_CONFIG_HOME: "/xdg" }),
		).toBe("/config/chats");
		expect(resolveCursorAgentChatStoreRootDirectoryPath({ CURSOR_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "/xdg" })).toBe(
			"/xdg/cursor/chats",
		);
		const originalCursorConfigDirectory = process.env.CURSOR_CONFIG_DIR;
		const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
		delete process.env.CURSOR_CONFIG_DIR;
		delete process.env.XDG_CONFIG_HOME;
		try {
			expect(resolveCursorAgentChatStoreRootDirectoryPath({})).toBe(join(homedir(), ".cursor", "chats"));
		} finally {
			if (originalCursorConfigDirectory !== undefined) process.env.CURSOR_CONFIG_DIR = originalCursorConfigDirectory;
			if (originalXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
	});
});

describe("Cursor chat bucket inspection", () => {
	it("keys the bucket by the physical working directory, the way cursor-agent's process.cwd() sees it", async () => {
		temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-cursor-chat-bucket-"));
		const physicalWorkingDirectoryPath = join(temporaryDirectoryPath, "physical-checkout");
		const symlinkedWorkingDirectoryPath = join(temporaryDirectoryPath, "symlinked-checkout");
		mkdirSync(physicalWorkingDirectoryPath);
		symlinkSync(physicalWorkingDirectoryPath, symlinkedWorkingDirectoryPath, "dir");
		const environmentOverrides = { CURSOR_CONFIG_DIR: join(temporaryDirectoryPath, "cursor-config") };

		const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
			symlinkedWorkingDirectoryPath,
			environmentOverrides,
		);
		// macOS 上 tmpdir 本身也在 /var → /private/var 的软链下，所以按 realpath 算。
		const expectedBucketKey = createHash("md5").update(realpathSync(physicalWorkingDirectoryPath)).digest("hex");
		expect(bucketDirectoryPath).toBe(join(temporaryDirectoryPath, "cursor-config", "chats", expectedBucketKey));
	});

	it("reads meta.json and store presence without opening sqlite, and classifies established conversations", async () => {
		temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-cursor-chat-bucket-"));
		const workingDirectoryPath = join(temporaryDirectoryPath, "checkout");
		mkdirSync(workingDirectoryPath);
		const environmentOverrides = { CURSOR_CONFIG_DIR: join(temporaryDirectoryPath, "cursor-config") };
		const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
			workingDirectoryPath,
			environmentOverrides,
		);
		const writeChat = (chatId: string, files: Record<string, string>) => {
			mkdirSync(join(bucketDirectoryPath, chatId), { recursive: true });
			for (const [fileName, content] of Object.entries(files)) {
				writeFileSync(join(bucketDirectoryPath, chatId, fileName), content);
			}
		};
		writeChat("established", { "store.db": "x", "meta.json": '{"hasConversation":true,"updatedAtMs":5}' });
		writeChat("first-turn-in-progress", { "store.db": "x", "meta.json": '{"hasConversation":false}' });
		writeChat("subagent", { "store.db": "x", "meta.json": '{"hasConversation":true,"isSubagent":true}' });
		writeChat("seed-copied-by-kanban-without-meta", { "store.db": "x" });
		writeChat("meta-without-store", { "meta.json": '{"hasConversation":true}' });

		const chats = await listCursorAgentChatsInWorkingDirectoryBucket({ workingDirectoryPath, environmentOverrides });
		const establishedChatIds = chats
			.filter(isCursorAgentChatConversationEstablished)
			.map((chat) => chat.chatId)
			.sort();
		expect(establishedChatIds).toEqual(["established", "seed-copied-by-kanban-without-meta"]);
		expect(chats.find((chat) => chat.chatId === "established")?.updatedAtMs).toBe(5);
	});

	it("returns no chats for a working directory whose bucket does not exist", async () => {
		temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-cursor-chat-bucket-"));
		await expect(
			listCursorAgentChatsInWorkingDirectoryBucket({
				workingDirectoryPath: join(temporaryDirectoryPath, "never-opened-by-cursor"),
				environmentOverrides: { CURSOR_CONFIG_DIR: join(temporaryDirectoryPath, "cursor-config") },
			}),
		).resolves.toEqual([]);
	});
});
