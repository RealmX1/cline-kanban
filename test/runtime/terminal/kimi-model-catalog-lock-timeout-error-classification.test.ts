import { afterEach, expect, it, vi } from "vitest";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { loadRefreshedKimiManagedModelCatalog } from "../../../src/terminal/kimi-latest-managed-stable-model-selection";

afterEach(() => vi.restoreAllMocks());

it.each([
	{ code: "ELOCKED", expectedMessage: "Kimi 模型目录刷新超时。" },
	{ code: "EACCES", expectedMessage: "Kimi 模型目录读取失败，请检查 Kimi CLI 与登录状态。" },
])("取锁返回 $code 时按原生错误分类，不依赖 abort 定时器先触发", async ({ code, expectedMessage }) => {
	const acquireLock = vi
		.spyOn(lockedFileSystem, "withLock")
		.mockRejectedValueOnce(Object.assign(new Error("隔离锁路径，不得出现在诊断中"), { code }));

	await expect(
		loadRefreshedKimiManagedModelCatalog({
			env: { KIMI_CODE_HOME: "/isolated-kimi-code-home" },
			timeoutMs: 60_000,
		}),
	).rejects.toThrow(expectedMessage);
	expect(acquireLock).toHaveBeenCalledOnce();
});
