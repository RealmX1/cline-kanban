import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildKanbanAgentHookCommandParts } from "../../src/core/kanban-command";
import { createTempDir } from "../utilities/temp-dir";

describe("Kanban hook 命令入口选择", () => {
	it("打包入口选择同目录轻量产物，缺少产物时兼容旧安装", () => {
		const { path, cleanup } = createTempDir("hook-command-packaged-entrypoint-");
		onTestFinished(cleanup);
		const cli = join(path, "cli.js");
		writeFileSync(cli, "");
		const context = { execPath: "/node", argv: ["/node", cli], execArgv: [] };
		expect(buildKanbanAgentHookCommandParts(["notify"], context)).toEqual(["/node", cli, "hooks", "notify"]);
		const hookCli = join(path, "kanban-agent-hook-cli.js");
		writeFileSync(hookCli, "");
		expect(buildKanbanAgentHookCommandParts(["notify"], context)).toEqual([
			"/node",
			realpathSync(hookCli),
			"hooks",
			"notify",
		]);
	});

	it("npm bin 软链接按真实安装目录定位轻量入口", () => {
		const { path, cleanup } = createTempDir("hook-command-npm-bin-symlink-");
		onTestFinished(cleanup);
		const distributionDirectory = join(path, "dist");
		mkdirSync(distributionDirectory);
		const cli = join(distributionDirectory, "cli.js");
		const hookCli = join(distributionDirectory, "kanban-agent-hook-cli.js");
		const npmBin = join(path, "kanban");
		writeFileSync(cli, "");
		writeFileSync(hookCli, "");
		symlinkSync(cli, npmBin);
		expect(
			buildKanbanAgentHookCommandParts(["notify"], {
				execPath: "/node",
				argv: ["/node", npmBin],
			}),
		).toEqual(["/node", realpathSync(hookCli), "hooks", "notify"]);
	});

	it("源码 tsx 启动参数保持原样，轻量入口派生的命令继续使用自己", () => {
		const { path, cleanup } = createTempDir("hook-command-source-entrypoint-");
		onTestFinished(cleanup);
		mkdirSync(join(path, "src"));
		const cli = join(path, "src", "cli.ts");
		const hookCli = join(path, "src", "kanban-agent-hook-cli.ts");
		writeFileSync(cli, "");
		writeFileSync(hookCli, "");
		const context = { execPath: "/node", argv: ["/node", cli], execArgv: ["--import", "tsx"] };
		expect(buildKanbanAgentHookCommandParts(["ingest"], context)).toEqual([
			"/node",
			"--import",
			"tsx",
			realpathSync(hookCli),
			"hooks",
			"ingest",
		]);
		expect(buildKanbanAgentHookCommandParts(["notify"], { ...context, argv: ["/node", hookCli] })).toEqual([
			"/node",
			"--import",
			"tsx",
			realpathSync(hookCli),
			"hooks",
			"notify",
		]);
		expect(
			buildKanbanAgentHookCommandParts(["notify"], {
				...context,
				argv: ["/node", "/node_modules/tsx/dist/cli.mjs", cli],
				execArgv: [],
			}),
		).toEqual(["/node", "/node_modules/tsx/dist/cli.mjs", realpathSync(hookCli), "hooks", "notify"]);
	});
});
