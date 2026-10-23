import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface RuntimeInvocationContext {
	execPath: string;
	argv: string[];
	execArgv?: string[];
}

function resolveNodeCommandPrefix(context: RuntimeInvocationContext): string[] {
	const execArgv = context.execArgv ?? [];
	if (execArgv.length === 0) {
		return [context.execPath];
	}
	return [context.execPath, ...execArgv];
}

function isLikelyTsxCliEntrypoint(value: string): boolean {
	const normalized = value.replaceAll("\\", "/").toLowerCase();
	if (normalized.endsWith("/tsx") || normalized.endsWith("/tsx.js")) {
		return true;
	}
	return normalized.includes("/tsx/") && normalized.endsWith("/cli.mjs");
}

function looksLikeEntrypointPath(value: string): boolean {
	if (!value) {
		return false;
	}
	if (value.includes("/") || value.includes("\\")) {
		return true;
	}
	if (/\.(?:mjs|cjs|js|ts|mts|cts)$/iu.test(value)) {
		return true;
	}
	return /kanban(?:\.(?:cmd|ps1|exe))?$/iu.test(value);
}

export function resolveKanbanCommandParts(
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	const commandPrefix = resolveNodeCommandPrefix(context);
	const entrypoint = context.argv[1];
	if (!entrypoint || !looksLikeEntrypointPath(entrypoint)) {
		return commandPrefix;
	}

	const tsxTarget = context.argv[2];
	if (tsxTarget && isLikelyTsxCliEntrypoint(entrypoint) && looksLikeEntrypointPath(tsxTarget)) {
		return [...commandPrefix, entrypoint, tsxTarget];
	}

	return [...commandPrefix, entrypoint];
}

export function buildKanbanCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	return [...resolveKanbanCommandParts(context), ...args];
}

// 新会话优先使用同一安装的轻量入口；旧安装没有该产物时保留原命令。
// 先解析软链接，避免 npm 全局 bin 路径把候选误定位到 bin 目录。
export function buildKanbanAgentHookCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
	},
): string[] {
	const prefix = resolveKanbanCommandParts(context);
	const entrypoint = prefix.at(-1);
	if (entrypoint && prefix.length > 1) {
		let canonicalEntrypoint = entrypoint;
		try {
			canonicalEntrypoint = realpathSync(entrypoint);
		} catch {
			/* 旧安装仍使用原入口。 */
		}
		if (/^(?:cli|kanban-agent-hook-cli)\.[cm]?[jt]s$/u.test(basename(canonicalEntrypoint))) {
			const hookEntrypoint = join(
				dirname(canonicalEntrypoint),
				`kanban-agent-hook-cli${extname(canonicalEntrypoint)}`,
			);
			if (existsSync(hookEntrypoint)) prefix[prefix.length - 1] = hookEntrypoint;
		}
	}
	return [...prefix, "hooks", ...args];
}
