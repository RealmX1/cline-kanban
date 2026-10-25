import { describe, expect, it, vi } from "vitest";
import { createTaskRelatedPreviewReadCache } from "./task-related-preview-read-cache";

describe("关联预览的共享有界缓存", () => {
	it("操作完成后的新快照不被操作前迟到的读取覆盖，同一刷新原因只失效一次", async () => {
		const cache = createTaskRelatedPreviewReadCache();
		let finishOld: (value: string) => void = () => {};
		const beforeAction = cache.read(
			"snapshot",
			() =>
				new Promise<string>((resolve) => {
					finishOld = resolve;
				}),
		);
		cache.invalidateIfFreshnessTokenChanged("snapshot", "after-action-1");
		const loadFresh = vi.fn(async () => "操作后");
		const afterAction = cache.read("snapshot", loadFresh, true);
		cache.invalidateIfFreshnessTokenChanged("snapshot", "after-action-1");
		const duplicate = cache.read("snapshot", loadFresh, true);
		expect(await afterAction).toBe("操作后");
		expect(await duplicate).toBe("操作后");
		finishOld("操作前");
		await beforeAction;
		expect(await cache.read("snapshot", loadFresh)).toBe("操作后");
		expect(loadFresh).toHaveBeenCalledOnce();
	});
	it("不同卡片副本合并在途请求，30 秒内复用，失败后可重试", async () => {
		let now = 0;
		const cache = createTaskRelatedPreviewReadCache(() => now);
		let finish: (value: string) => void = () => {};
		const load = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		const first = cache.read("workspace/task/1/page", load);
		const duplicate = cache.read("workspace/task/1/page", load);
		expect(load).toHaveBeenCalledTimes(1);
		finish("第一世");
		expect(await first).toBe("第一世");
		expect(await duplicate).toBe("第一世");
		expect(await cache.read("workspace/task/1/page", load)).toBe("第一世");
		expect(await cache.read("workspace/task/2/page", async () => "第二世")).toBe("第二世");
		now = 30_001;
		await expect(
			cache.read("workspace/task/1/page", async () => {
				throw new Error("离线");
			}),
		).rejects.toThrow("离线");
		expect(await cache.read("workspace/task/1/page", async () => "刷新成功")).toBe("刷新成功");
	});
	it("最多保存 100 项，强制刷新也合并在途请求", async () => {
		const cache = createTaskRelatedPreviewReadCache();
		for (let index = 0; index < 101; index++) await cache.read(String(index), async () => index);
		const evicted = vi.fn(async () => 200);
		expect(await cache.read("0", evicted)).toBe(200);
		expect(evicted).toHaveBeenCalledOnce();
		const load = vi.fn(async () => 300);
		await Promise.all([cache.read("0", load, true), cache.read("0", load, true)]);
		expect(load).toHaveBeenCalledOnce();
	});
});
