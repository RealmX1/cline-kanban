import type * as FilesystemPromises from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

const directorySyncFailure = vi.hoisted(() => ({ enabled: false, directoryPath: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof FilesystemPromises>();
	return {
		...original,
		open: async (...args: Parameters<typeof original.open>) => {
			const handle = await original.open(...args);
			if (String(args[0]) === directorySyncFailure.directoryPath && directorySyncFailure.enabled) {
				handle.sync = async () => {
					throw new Error("模拟目录 fsync 故障");
				};
			}
			return handle;
		},
	};
});

afterEach(() => {
	directorySyncFailure.enabled = false;
});

it("rename 后持久化失败，同内容重试仍须取得目录持久化证明", async () => {
	const directory = createTempDir("kanban-durable-retry-");
	try {
		const path = join(directory.path, "intent.json");
		const filesystem = new LockedFileSystem();
		directorySyncFailure.directoryPath = directory.path;
		directorySyncFailure.enabled = true;
		await expect(filesystem.writeTextFileAtomic(path, "intent", { durable: true, lock: null })).rejects.toThrow(
			"fsync",
		);
		expect(await readFile(path, "utf8")).toBe("intent");
		await expect(filesystem.writeTextFileAtomic(path, "intent", { durable: true, lock: null })).rejects.toThrow(
			"fsync",
		);
		directorySyncFailure.enabled = false;
		await filesystem.writeTextFileAtomic(path, "intent", { durable: true, lock: null });
	} finally {
		directory.cleanup();
	}
});
