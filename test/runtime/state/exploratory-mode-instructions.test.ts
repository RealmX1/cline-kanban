import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 指令文件落在 ~/.cline/kanban 之下；测试把 homedir 重定向到临时目录，
// 绝不在别人的真实运行目录上写文件。
const testHome = { path: "" };
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => testHome.path };
});

// 被测模块有模块级 ensurePromise 缓存（生产上 homedir 恒定，缓存无害）；测试每个用例换
// 新临时 home，必须经 resetModules 拿一份带全新缓存的模块实例。
async function loadModule() {
	vi.resetModules();
	return await import("../../../src/state/exploratory-mode-instructions");
}

describe("exploratory-mode-instructions — Kanban 托管指令文件落盘", () => {
	beforeEach(async () => {
		testHome.path = await mkdtemp(join(tmpdir(), "exploratory-mode-instructions-test-"));
	});

	afterEach(async () => {
		await rm(testHome.path, { recursive: true, force: true });
		testHome.path = "";
	});

	it("路径落在 ~/.cline/kanban/agent-exploratory-mode-instructions/ 下", async () => {
		const { getExploratoryModeInstructionsPath } = await loadModule();
		expect(getExploratoryModeInstructionsPath()).toBe(
			join(
				testHome.path,
				".cline",
				"kanban",
				"agent-exploratory-mode-instructions",
				"exploratory-mode-conversation-etiquette-and-findings.md",
			),
		);
	});

	it("首次 ensure 落盘指令正文；正文只含探索礼仪与 findings 工作流，不再要求 agent 埋 marker / 手写结构", async () => {
		const { ensureExploratoryModeInstructionsFile } = await loadModule();
		const path = await ensureExploratoryModeInstructionsFile();
		const content = await readFile(path, "utf8");
		expect(content).toContain("exploration thread graph");
		expect(content).toContain("切换话题时明说");
		expect(content).toContain("收口时明说");
		expect(content).toContain("kanban exploratory get-findings");
		expect(content).toContain("kanban exploratory ingest-finding-candidate");
		expect(content).toContain("suggested_pending_confirmation");
		// 结构由 work-branch 作业维护：不得再出现 marker 约定与 map 写回 CLI。
		expect(content).not.toContain("kanban:map-anchor");
		expect(content).not.toContain("ingest-map-update");
		expect(content).not.toContain("get-session-map");
	});

	it("内容未漂移时跨进程（新模块实例）ensure 不重写（幂等）", async () => {
		const first = await loadModule();
		const path = await first.ensureExploratoryModeInstructionsFile();
		const firstStat = await stat(path);
		// 主动推进 mtime 精度窗口，避免同毫秒误判。
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 新模块实例 = 模拟另一个进程：缓存为空，走真实的「读文件比对内容」幂等路径。
		const second = await loadModule();
		await second.ensureExploratoryModeInstructionsFile();
		const secondStat = await stat(path);
		expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
	});

	it("内容漂移（旧版正文）时 ensure 重写为最新", async () => {
		const { getExploratoryModeInstructionsPath, ensureExploratoryModeInstructionsFile } = await loadModule();
		const path = getExploratoryModeInstructionsPath();
		await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".."), { recursive: true }));
		await writeFile(path, "旧版指令正文", "utf8");
		await ensureExploratoryModeInstructionsFile();
		const content = await readFile(path, "utf8");
		expect(content).not.toBe("旧版指令正文");
		expect(content).toContain("exploration thread graph");
	});
});
