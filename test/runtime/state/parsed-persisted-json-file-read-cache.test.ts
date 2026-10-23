import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createParsedPersistedJsonFileReadCache } from "../../../src/state/parsed-persisted-json-file-read-cache";
import { createTempDir } from "../../utilities/temp-dir";

describe("持久 JSON 的只读解析缓存", () => {
	it("复用未变化的文件，并在同尺寸原子替换后重新读取", async () => {
		const { path: directory, cleanup } = createTempDir("parsed-persisted-json-read-cache-");
		onTestFinished(cleanup);
		const path = join(directory, "board.json");
		await writeFile(path, "old");
		const cache = createParsedPersistedJsonFileReadCache<string>();
		const load = vi.fn(async () => "old");
		expect(await cache.read(path, load)).toBe("old");
		expect(await cache.read(path, load)).toBe("old");
		expect(load).toHaveBeenCalledTimes(1);
		const replacement = join(directory, "replacement.json");
		await writeFile(replacement, "new");
		await rename(replacement, path);
		load.mockResolvedValue("new");
		expect(await cache.read(path, load)).toBe("new");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("同一次文件版本的并发读取只解析一次，forget 后不能由旧读取重新填入", async () => {
		const { path: directory, cleanup } = createTempDir("parsed-persisted-json-concurrent-read-");
		onTestFinished(cleanup);
		const path = join(directory, "board.json");
		await writeFile(path, "old");
		const cache = createParsedPersistedJsonFileReadCache<string>();
		let finishRead: ((value: string) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finishRead = resolve;
				}),
		);
		const first = cache.read(path, load);
		const second = cache.read(path, load);
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		cache.forget(path);
		finishRead?.("old");
		expect(await Promise.all([first, second])).toEqual(["old", "old"]);
		const readAfterForget = vi.fn(async () => "fresh");
		expect(await cache.read(path, readAfterForget)).toBe("fresh");
		expect(readAfterForget).toHaveBeenCalledTimes(1);
	});

	it("读取期间文件变化时不缓存旧结果，文件消失后不回退到缓存", async () => {
		const { path: directory, cleanup } = createTempDir("parsed-persisted-json-changing-read-");
		onTestFinished(cleanup);
		const path = join(directory, "board.json");
		await mkdir(directory, { recursive: true });
		await writeFile(path, "old");
		const cache = createParsedPersistedJsonFileReadCache<string>();
		await cache.read(path, async () => {
			await writeFile(path, "changed");
			return "old";
		});
		const readChanged = vi.fn(async () => "changed");
		expect(await cache.read(path, readChanged)).toBe("changed");
		expect(readChanged).toHaveBeenCalledTimes(1);
		await rm(path);
		await expect(
			cache.read(path, async () => {
				throw new Error("文件不存在");
			}),
		).rejects.toThrow("文件不存在");
	});
});
