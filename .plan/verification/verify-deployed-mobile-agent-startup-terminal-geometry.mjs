// 部署后只读验证：执行正在发布的 source map 中的尺寸估算模块，不创建任务、不调用模型。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

async function verifyDeployedMobileStartupGeometry() {
	const origin = `http://${process.env.KANBAN_RUNTIME_HOST || "127.0.0.1"}:${process.env.KANBAN_RUNTIME_PORT || "3484"}`;
	const request = async (url) => {
		const response = await fetch(url, { signal: AbortSignal.timeout(10000), cache: "no-store" });
		if (!response.ok) throw new Error(`运行实例读取失败：${response.status} ${url}`);
		return response;
	};
	const html = await (await request(origin)).text();
	const entrypoints = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/gu)].map((match) => match[1]);
	const deployedSources = new Map();
	for (const entrypoint of entrypoints) {
		const map = await (await request(new URL(`${entrypoint}.map`, origin))).json();
		for (let index = 0; index < map.sources.length; index += 1) {
			deployedSources.set(map.sources[index], map.sourcesContent[index]);
		}
	}
	const sourceFor = (suffix) => {
		const matches = [...deployedSources].filter(([path]) => path.endsWith(suffix));
		assert.equal(matches.length, 1, `运行实例未发布唯一源码模块：${suffix}`);
		assert.equal(typeof matches[0][1], "string", `运行实例缺少源码内容：${suffix}`);
		return matches[0][1];
	};
	const deployment = JSON.parse(await readFile(join(homedir(), ".cline/kanban/last-deployed-source-commit.json"), "utf8"));
	const requireFromDeployedCheckout = createRequire(join(deployment.sourceCheckoutPath, "package.json"));
	const ts = requireFromDeployedCheckout("typescript");
	const sourceModules = {
		"@/runtime/task-session-geometry": sourceFor("/runtime/task-session-geometry.ts"),
		"@/utils/mobile-viewport-breakpoint": sourceFor("/utils/mobile-viewport-breakpoint.ts"),
	};
	const startupSource = sourceFor("/terminal/agent-terminal-geometry-for-task-session-spawn.ts");
	const results = [];
	for (const [viewportWidth, expectedColumns] of [[320, 35], [390, 43], [393, 44], [430, 48], [768, 91], [769, 46], [1440, 60]]) {
		const browserWindow = {
			innerWidth: viewportWidth,
			innerHeight: 900,
			matchMedia: (query) => {
				const maximum = /max-width:\s*(\d+)px/u.exec(query);
				assert.ok(maximum, `未知媒体查询：${query}`);
				return { matches: viewportWidth <= Number(maximum[1]) };
			},
		};
		const dependencyExports = new Map([
			["@/resize/detail-terminal-panel-width", { loadDetailTerminalPanelWidth: () => 520 }],
			["@/resize/use-card-detail-layout", { MIN_DETAIL_DIFF_PANEL_WIDTH_PX: 360 }],
			["@/terminal/terminal-geometry-registry", { getTerminalGeometry: () => null }],
		]);
		const evaluateModule = (source, expression = "exports") => {
			const exports = {};
			const compiled = ts.transpileModule(source, {
				compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			}).outputText;
			return runInNewContext(`${compiled}\n${expression}`, {
				exports,
				window: browserWindow,
				require: (name) => {
					assert.ok(dependencyExports.has(name), `部署模块增加了未建模依赖，请更新验证资产：${name}`);
					return dependencyExports.get(name);
				},
			}, { timeout: 1000 });
		};
		for (const [name, source] of Object.entries(sourceModules)) dependencyExports.set(name, evaluateModule(source));
		const observed = evaluateModule(startupSource, 'exports.resolveAgentTerminalGeometryForTaskSessionSpawn("deployed-mobile-background-verification")');
		assert.equal(observed.cols, expectedColumns, `${viewportWidth}px 视口的已发布后台启动列数错误`);
		assert.equal(observed.rows, 53);
		results.push({ viewportWidth, cols: observed.cols, rows: observed.rows });
	}
	console.log(JSON.stringify({ passed: true, origin, results }));
}

verifyDeployedMobileStartupGeometry().catch((error) => {
	console.error(`部署后验证未通过：${error.message}`);
	process.exitCode = 1;
});
