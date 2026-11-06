import { channel } from "node:diagnostics_channel";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectGitRepositoryInfo } from "../../../src/state/workspace-state";
import { runGit } from "../../../src/workspace/git-utils";

vi.mock("../../../src/workspace/git-utils", () => ({ runGit: vi.fn() }));

describe("工作区 Git 探测在等待子进程时让出运行时", () => {
	let currentBranch: string;
	beforeEach(() => {
		currentBranch = "main";
		vi.mocked(runGit)
			.mockReset()
			.mockImplementation(async (cwd, args) => {
				const stdout =
					args[0] === "rev-parse"
						? cwd
						: args[0] === "for-each-ref"
							? "main\t2026-01-01T00:00:00Z"
							: args.at(-1) === "HEAD"
								? currentBranch
								: "";
				return { ok: true, stdout, stderr: "", output: stdout, error: null, exitCode: 0 };
			});
	});
	it("慢 Git 尚未返回时事件循环仍可执行，后续分支变化不会被缓存", async () => {
		let release: () => void = () => undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = vi.mocked(runGit).getMockImplementation();
		if (!original) throw new Error("缺少 Git 探测夹具。");
		vi.mocked(runGit).mockImplementationOnce(async (...args) => {
			await waiting;
			return await original(...args);
		});
		let completed = false;
		const pending = detectGitRepositoryInfo("/isolated/project").then((result) => {
			completed = true;
			return result;
		});
		await setImmediate();
		expect(completed).toBe(false);
		release();
		expect(await pending).toMatchObject({
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main", lastCommitDate: "2026-01-01T00:00:00Z" }],
		});
		currentBranch = "feature/current";
		expect((await detectGitRepositoryInfo("/isolated/project")).currentBranch).toBe("feature/current");
	});
	it("跨项目并发探测也遵守共享子进程预算", async () => {
		const observationChannel = channel("cline-kanban.workspace-context-git-probe-concurrency-wait");
		const waits: number[] = [];
		const observeWait = (message: unknown) => {
			if (
				message &&
				typeof message === "object" &&
				"waitDurationMs" in message &&
				typeof message.waitDurationMs === "number"
			)
				waits.push(message.waitDurationMs);
		};
		observationChannel.subscribe(observeWait);
		let active = 0;
		let peak = 0;
		let release: () => void = () => undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = vi.mocked(runGit).getMockImplementation();
		if (!original) throw new Error("缺少 Git 探测夹具。");
		vi.mocked(runGit).mockImplementation(async (...args) => {
			active += 1;
			peak = Math.max(active, peak);
			await waiting;
			try {
				return await original(...args);
			} finally {
				active -= 1;
			}
		});
		const pending = Promise.all(
			Array.from({ length: 12 }, (_, index) => detectGitRepositoryInfo(`/isolated/project-${index}`)),
		);
		try {
			await setImmediate();
			expect(peak).toBe(4);
		} finally {
			release();
			await pending;
			observationChannel.unsubscribe(observeWait);
		}
		expect(peak).toBe(4);
		expect(waits.length).toBeGreaterThan(0);
		expect(waits.every((wait) => wait >= 0)).toBe(true);
	});
});
