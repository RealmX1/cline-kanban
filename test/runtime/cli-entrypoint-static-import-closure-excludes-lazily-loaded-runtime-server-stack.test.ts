// 确定性守护「命令型 CLI 不在启动时求值 runtime server 栈」：src/cli.ts 的 startServer() 用动态 import
// 懒加载 server 栈（见其中关于 25ba59f 的注释），task / hooks 等命令型子命令走轻量路径。
//
// 为什么需要这条：task-command-exit 集成测试里「CLI 会退出」类等待已改成两档，软档（8s）只告警。
// 若有人把 server 栈改回静态 import，命令型 CLI 的启动耗时会明显变长，却只会在本地产生软档告警——
// 这条用例把那类退化重新变成确定性失败，与宿主负载无关。
//
// 做法：用 esbuild 的 metafile 求 cli.ts 的静态 import 闭包（只沿 import-statement / require 边，
// 不沿 dynamic-import 边），断言懒加载的 server 栈入口都不在闭包里。
import { resolve } from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const CLI_ENTRYPOINT_RELATIVE_PATH = "src/cli.ts";

// 只能经 startServer() 的动态 import 加载的 server 栈入口（以及它们背后最重的 SDK 运行时与会话管理）。
const LAZILY_LOADED_RUNTIME_SERVER_STACK_MODULE_RELATIVE_PATHS = [
	"src/server/runtime-server.ts",
	"src/server/runtime-state-hub.ts",
	"src/server/workspace-registry.ts",
	"src/server/shutdown-coordinator.ts",
	"src/server/directory-picker.ts",
	"src/server/shell.ts",
	"src/trpc/app-router.ts",
	"src/cline-sdk/sdk-runtime-boundary.ts",
	"src/terminal/session-manager.ts",
];

async function computeStaticImportClosureAndAllBundledModulesOfCliEntrypoint(): Promise<{
	staticImportClosureModuleRelativePaths: ReadonlySet<string>;
	allBundledModuleRelativePaths: ReadonlySet<string>;
}> {
	const buildResult = await build({
		absWorkingDir: resolve(process.cwd()),
		entryPoints: [CLI_ENTRYPOINT_RELATIVE_PATH],
		bundle: true,
		write: false,
		metafile: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outdir: "cli-static-import-closure-probe-output-never-written",
		logLevel: "silent",
	});
	const bundledModuleInputsByRelativePath = buildResult.metafile.inputs;
	const staticImportClosureModuleRelativePaths = new Set<string>([CLI_ENTRYPOINT_RELATIVE_PATH]);
	const modulesPendingTraversal = [CLI_ENTRYPOINT_RELATIVE_PATH];
	for (
		let currentModulePath = modulesPendingTraversal.shift();
		currentModulePath;
		currentModulePath = modulesPendingTraversal.shift()
	) {
		for (const importEdge of bundledModuleInputsByRelativePath[currentModulePath]?.imports ?? []) {
			if (importEdge.external || importEdge.kind === "dynamic-import") {
				continue;
			}
			if (!staticImportClosureModuleRelativePaths.has(importEdge.path)) {
				staticImportClosureModuleRelativePaths.add(importEdge.path);
				modulesPendingTraversal.push(importEdge.path);
			}
		}
	}
	return {
		staticImportClosureModuleRelativePaths,
		allBundledModuleRelativePaths: new Set(Object.keys(bundledModuleInputsByRelativePath)),
	};
}

describe("cli entrypoint static import closure", () => {
	it("命令型子命令的静态 import 闭包不含懒加载的 runtime server 栈", async () => {
		const { staticImportClosureModuleRelativePaths, allBundledModuleRelativePaths } =
			await computeStaticImportClosureAndAllBundledModulesOfCliEntrypoint();

		// 防空转：这些模块确实经动态 import 可达。路径写错或被改名时，这里先失败，而不是让下面的断言平凡成立。
		for (const lazilyLoadedModulePath of LAZILY_LOADED_RUNTIME_SERVER_STACK_MODULE_RELATIVE_PATHS) {
			expect(allBundledModuleRelativePaths, `${lazilyLoadedModulePath} 不在 cli.ts 的打包图里`).toContain(
				lazilyLoadedModulePath,
			);
		}
		const lazilyLoadedModulesPulledIntoStaticClosure =
			LAZILY_LOADED_RUNTIME_SERVER_STACK_MODULE_RELATIVE_PATHS.filter((lazilyLoadedModulePath) =>
				staticImportClosureModuleRelativePaths.has(lazilyLoadedModulePath),
			);
		expect(
			lazilyLoadedModulesPulledIntoStaticClosure,
			"这些 server 栈模块被静态 import 进了 cli.ts，命令型 CLI 每次启动都会求值它们（25ba59f 类退化）",
		).toEqual([]);
	});
});
