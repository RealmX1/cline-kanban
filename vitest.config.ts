import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

const runtimeIntegrationTestFilePatterns = ["test/**/*.integration.test.ts"];

const repositoryWorkspaceExclusionPatterns = [
	"apps/**",
	"packages/**",
	"web-ui/**",
	"third_party/**",
	"**/node_modules/**",
	"**/dist/**",
	".worktrees/**",
];

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		pool: "forks",
		// 两个 test projects 仍共享宿主 CPU；无界 worker 会让带硬超时的
		// server/CLI 测试因调度饥饿产生假失败。保留文件并行，但把全局并发钳为常数。
		maxWorkers: 2,
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: repositoryWorkspaceExclusionPatterns,
		testTimeout: 15_000,
		projects: [
			{
				extends: true,
				test: {
					name: "precommit-safe",
					sequence: { groupOrder: 0 },
					include: ["test/**/*.test.ts"],
					exclude: [...repositoryWorkspaceExclusionPatterns, ...runtimeIntegrationTestFilePatterns],
				},
			},
			{
				extends: true,
				test: {
					name: "runtime-integration",
					sequence: { groupOrder: 1 },
					include: ["test/**/*.integration.test.ts"],
					exclude: repositoryWorkspaceExclusionPatterns,
					// 真实 server/CLI/WebSocket 会在文件内再派生多个进程；跨文件并发会让
					// 启停超时退化为宿主调度测试，因此串行运行。
					fileParallelism: false,
					maxWorkers: 1,
				},
			},
		],
	},
});
