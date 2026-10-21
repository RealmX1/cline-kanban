import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import * as esbuild from "esbuild";
import {
	KANBAN_BUILD_STAGING_DIRECTORY_NAME_PREFIX,
	promoteStagedKanbanBuildOutputIntoDistributionDirectory,
	removeAbandonedKanbanBuildStagingDirectories,
} from "./promote-staged-kanban-build-output-into-distribution-directory.mjs";

/**
 * 产物目录默认是 `dist`。可用 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY` 改到别处，
 * 例如在 dist 软链到在线 runtime 产物的 task worktree 里验证构建。
 */
const distributionDirectoryPath = resolve(process.env.KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY ?? "dist");
const builtWebUiDirectoryPath = resolve("web-ui/dist");

/**
 * Runtime externals. `node-pty` is a native addon with a compiled binding
 * and a spawn-helper binary that must live on disk, so it can't be bundled.
 * Everything else esbuild can inline.
 */
const external = ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"];

/** Bake OTEL telemetry env vars into the bundle at build time. */
const define = {
	"process.env.NODE_ENV": '"production"',
	"process.env.OTEL_TELEMETRY_ENABLED": JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_ENDPOINT": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ""),
	"process.env.OTEL_METRICS_EXPORTER": JSON.stringify(process.env.OTEL_METRICS_EXPORTER ?? ""),
	"process.env.OTEL_LOGS_EXPORTER": JSON.stringify(process.env.OTEL_LOGS_EXPORTER ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_PROTOCOL": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? ""),
	"process.env.OTEL_METRIC_EXPORT_INTERVAL": JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_HEADERS": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? ""),
};

/**
 * Bundled CJS dependencies call require() on Node built-ins (process, fs, etc.).
 * ESM output needs a real require() function for those calls to work.
 */
const cjsShimBanner = [
	'import { createRequire as __kanban_createRequire } from "node:module";',
	"const require = __kanban_createRequire(import.meta.url);",
].join("\n");

/** Shared esbuild options for both entry points. */
const shared = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	external,
	define,
	sourcemap: true,
	packages: "bundle",
	banner: { js: cjsShimBanner },
};

// 全部产物先写进 dist 内的暂存目录（同一文件系统，换入时 rename 才是原子的），再逐文件换入。
// 构建或上传失败时 dist 保持原样。
if (!existsSync(join(builtWebUiDirectoryPath, "index.html"))) {
	console.error(`${builtWebUiDirectoryPath}/index.html is missing; run \`npm run web:build\` first.`);
	process.exit(1);
}
await mkdir(distributionDirectoryPath, { recursive: true });
await removeAbandonedKanbanBuildStagingDirectories(distributionDirectoryPath);
const stagingDirectoryPath = join(
	distributionDirectoryPath,
	`${KANBAN_BUILD_STAGING_DIRECTORY_NAME_PREFIX}${process.pid}-${randomUUID()}`,
);

/**
 * esbuild 按最终路径（dist 下）计算 sourcemap 里的相对 sources，所以 outfile 写最终路径、`write: false`，
 * 再把内存里的产物写进暂存目录的对应位置。直接以暂存目录为 outfile 会让 sources 多出一层 `../`。
 */
async function buildBundleIntoStagingDirectory(buildOptions) {
	const result = await esbuild.build({ ...buildOptions, write: false });
	for (const outputFile of result.outputFiles) {
		const stagedOutputFilePath = join(stagingDirectoryPath, relative(distributionDirectoryPath, outputFile.path));
		await mkdir(dirname(stagedOutputFilePath), { recursive: true });
		await writeFile(stagedOutputFilePath, outputFile.contents);
	}
	return result;
}

/**
 * agent session PTY host 的依赖闭包只允许这些源文件（node:* 与 external 的 node-pty 不进 metafile.inputs）。
 * 理由：host bundle 的内容决定 build identity，identity 一变就开新 generation、旧 host 要排空才退出。
 * 闭包若混进 runtime 其他模块，runtime 的任何改动都会无谓地换掉 host generation。
 */
const AGENT_SESSION_PTY_HOST_BUNDLE_ALLOWED_SOURCE_PATH_PREFIXES = [
	"src/agent-session-pty-host/host-process/",
	"src/agent-session-pty-host/wire-protocol/",
	"src/terminal/pty-process-group-termination-signal-policy.ts",
];

function assertAgentSessionPtyHostBundleImportsOnlyAllowedSources(metafile) {
	const disallowedInputPaths = Object.keys(metafile.inputs).filter(
		(inputPath) =>
			!AGENT_SESSION_PTY_HOST_BUNDLE_ALLOWED_SOURCE_PATH_PREFIXES.some((allowedPrefix) =>
				inputPath.startsWith(allowedPrefix),
			),
	);
	if (disallowedInputPaths.length > 0) {
		throw new Error(
			`agent session pty host bundle imports modules outside its allowed closure:\n  ${disallowedInputPaths.join("\n  ")}`,
		);
	}
}

try {
	await Promise.all([
		// CLI binary
		buildBundleIntoStagingDirectory({
			...shared,
			entryPoints: ["src/cli.ts"],
			outfile: join(distributionDirectoryPath, "cli.js"),
			banner: { js: `#!/usr/bin/env node\n${cjsShimBanner}` },
		}),
		// Library export
		buildBundleIntoStagingDirectory({
			...shared,
			entryPoints: ["src/index.ts"],
			outfile: join(distributionDirectoryPath, "index.js"),
		}),
		// Codex 控制宿主监督进程；由该会话 PTY 持有，不进入通用 PTY host 的 build identity。
		buildBundleIntoStagingDirectory({
			...shared,
			entryPoints: ["src/codex-native-session-control-host/codex-native-session-control-host-process-entry.ts"],
			outfile: join(distributionDirectoryPath, "codex-native-session-control-host.js"),
		}),
		// agent session PTY host（独立长驻进程，持有 agent 会话的 PTY master）
		buildBundleIntoStagingDirectory({
			...shared,
			entryPoints: ["src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts"],
			outfile: join(distributionDirectoryPath, "agent-session-pty-host.js"),
			metafile: true,
		}).then((result) => assertAgentSessionPtyHostBundleImportsOnlyAllowedSources(result.metafile)),
	]);

	console.log("esbuild: bundled cli.js, index.js, agent-session-pty-host.js and codex-native-session-control-host.js");

	await copyFile(
		"src/notifications/notification-lifecycle-database-worker.mjs",
		join(stagingDirectoryPath, "notification-lifecycle-database-worker.mjs"),
	);
	await copyFile(
		"src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
		join(stagingDirectoryPath, "inter-work-unit-relation-ledger-database-worker.mjs"),
	);
	// dereference：task worktree 的 `web-ui/dist` 是软链接，必须复制它指向的真实文件，不能把软链接本身放进产物。
	await cp(builtWebUiDirectoryPath, join(stagingDirectoryPath, "web-ui"), { recursive: true, dereference: true });
	await chmod(join(stagingDirectoryPath, "cli.js"), 0o755);

	// sentry-cli 的 inject 会改写产物本身，必须在换入前对暂存目录做。
	const sentryUpload = spawnSync(process.execPath, ["scripts/upload-sentry-sourcemaps.mjs"], {
		env: { ...process.env, KANBAN_SENTRY_SOURCEMAP_UPLOAD_DISTRIBUTION_DIRECTORY: stagingDirectoryPath },
		stdio: "inherit",
	});
	if (sentryUpload.status !== 0) {
		throw new Error(`upload-sentry-sourcemaps exited with ${sentryUpload.status ?? sentryUpload.signal}`);
	}

	const { promotedRelativeFilePathsInPromotionOrder, removedStaleRelativeFilePaths } =
		await promoteStagedKanbanBuildOutputIntoDistributionDirectory({ stagingDirectoryPath, distributionDirectoryPath });
	console.log(
		`build: promoted ${promotedRelativeFilePathsInPromotionOrder.length} files into ${distributionDirectoryPath}, removed ${removedStaleRelativeFilePaths.length} stale web-ui files`,
	);
} finally {
	await rm(stagingDirectoryPath, { recursive: true, force: true });
}
