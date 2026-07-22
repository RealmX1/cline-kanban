// Kimi Code（Moonshot 的原生终端 agent）的 Kanban hook 接线。
//
// 与 codex 不同，kimi 没有 `-c key=value` 之类的 CLI 配置覆盖：hook 只能声明在
// config.toml 的 `[[hooks]]` 数组里，且 kimi 只从「已解析的 user-global home」
//（`KIMI_CODE_HOME` env > `~/.kimi-code`）读取 hook——实测 project-local
// `<cwd>/.kimi-code/config.toml` 的 `[[hooks]]` 不会触发。
//
// 为了在「让 Kanban 的 hook 生效」与「不改动用户的全局 `~/.kimi-code/config.toml`
//（用户手动 `kimi` 会话仍用它）」之间取得干净分离，Kanban 派生一个自己托管的
// seeded home：把承载登录态的目录（oauth / credentials / device_id / tui.toml）
// 软链到用户真实 home（登录/令牌轮换自动跟进），并写一份 config.toml =
// 用户全局 config（provider / model / default_model 等）剔除既有 `[[hooks]]` 后
// 追加 Kanban 的 `[[hooks]]`。Kanban 启动 kimi 时把 `KIMI_CODE_HOME` 指向该 seeded
// home；每任务身份经 createHookRuntimeEnv 的 env 变量随进程携带，故一份共享的
// seeded home 即可服务所有任务（会话按 workspace/cwd 天然隔离）。

import { access, chmod, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeHookEvent } from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

// kimi 单条 hook 的时间预算（秒）。与用户全局 config 里既有 hook（如 Orca 注入的）一致取 10s。
const KIMI_HOOK_TIMEOUT_SECONDS = 10;

// 承载登录态 / 客户端偏好的条目：软链到用户真实 home，使令牌轮换、重新登录自动生效。
const KIMI_SEEDED_HOME_LINKED_ENTRIES = ["oauth", "credentials", "device_id", "tui.toml"] as const;

// seeded config.toml 复制自用户全局 config，可能含 `providers.*.api_key` 明文。强制 owner-only 权限，
// 避免默认 umask(022) 下经 writeFile 写成 0644、把 API key 泄漏给同机其它用户。
const KIMI_SEEDED_CONFIG_FILE_MODE = 0o600;
// seeded home 目录同样限制为 owner-only，避免其它用户枚举目录、或经软链探查用户真实 home 的登录态。
const KIMI_SEEDED_HOME_DIRECTORY_MODE = 0o700;

// kimi 的 Claude 风格 hook 事件 → Kanban 状态转换事件。镜像 claudeAdapter 的事件表，
// 落到 kimi 暴露的事件集合（无 Notification / SubagentStop / matcher）。
const KIMI_HOOK_EVENT_MAP: ReadonlyArray<{ kimiEvent: string; kanbanEvent: RuntimeHookEvent }> = [
	{ kimiEvent: "UserPromptSubmit", kanbanEvent: "to_in_progress" },
	{ kimiEvent: "PreToolUse", kanbanEvent: "activity" },
	{ kimiEvent: "PostToolUse", kanbanEvent: "to_in_progress" },
	{ kimiEvent: "PostToolUseFailure", kanbanEvent: "to_in_progress" },
	{ kimiEvent: "PermissionRequest", kanbanEvent: "to_review" },
	{ kimiEvent: "Stop", kanbanEvent: "to_review" },
	{ kimiEvent: "StopFailure", kanbanEvent: "to_review" },
];

// 解析 kimi 的全局 home（seeded home 的种子来源）：`KIMI_CODE_HOME` env > `~/.kimi-code`。
export function resolveGlobalKimiCodeHome(env: NodeJS.ProcessEnv): string {
	const override = env.KIMI_CODE_HOME?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".kimi-code");
}

// Kanban 托管的 seeded KIMI_CODE_HOME 路径（所有 kimi 任务共享）。
export function getKanbanManagedKimiCodeHome(): string {
	return join(getRuntimeHomePath(), "hooks", "kimi", "code-home");
}

function buildKimiHookIngestCommand(kanbanEvent: RuntimeHookEvent): string {
	return buildKanbanCommandParts(["hooks", "ingest", "--event", kanbanEvent, "--source", "kimi"])
		.map(quoteShellArg)
		.join(" ");
}

function escapeForTomlBasicString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// 生成 Kanban 托管的 `[[hooks]]` TOML 片段。
export function buildKanbanManagedKimiHooksToml(): string {
	return KIMI_HOOK_EVENT_MAP.map(({ kimiEvent, kanbanEvent }) => {
		const command = escapeForTomlBasicString(buildKimiHookIngestCommand(kanbanEvent));
		return `[[hooks]]\nevent = "${kimiEvent}"\ncommand = "${command}"\ntimeout = ${KIMI_HOOK_TIMEOUT_SECONDS}\n`;
	}).join("\n");
}

// 从 config.toml 文本剔除所有既有 `[[hooks]]` 数组表（用户 / 其它工具如 Orca 注入的），
// 保留 provider / model / service / default_model 等其余配置。kimi 的 hook 表是扁平的
// event / command / timeout 键值块，故按「从 `[[hooks]]` 头行起、直到下一个表头 `[` 前」
// 整段删除；TOML 规定顶层键必先于任何表头，故表头之后无需保留的顶层键会被误删的情形不存在。
export function stripTomlHookTables(configText: string): string {
	const lines = configText.split("\n");
	const kept: string[] = [];
	let insideHookTable = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "[[hooks]]") {
			insideHookTable = true;
			continue;
		}
		if (insideHookTable && trimmed.startsWith("[")) {
			insideHookTable = false;
		}
		if (!insideHookTable) {
			kept.push(line);
		}
	}
	return kept.join("\n");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// 校验既有 seeded 软链（解析后）是否指向期望源：realpath 两端比对；断链或源缺失均视为不匹配。
// 镜像 agent-session-materialization.ts 的 targetReferencesSource 模式（此处用于「不一致则替换」而非「抛错」）。
async function seededSymlinkResolvesToExpectedSource(sourcePath: string, targetPath: string): Promise<boolean> {
	try {
		const [sourceRealPath, targetRealPath] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
		return sourceRealPath === targetRealPath;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

// 幂等软链：源不存在（如未登录、缺该文件）则跳过。目标已存在时不再无条件保留，而是校验其实际指向：
// 与期望源一致则保留；不一致或已成断链（用户切换 KIMI_CODE_HOME、旧全局 home 失效等）则删除重建，
// 避免 config.toml 从新 home 重建、而 oauth/credentials 仍软链旧 home 的混合配置 + 鉴权失败。
async function ensureAuthPassthroughSymlink(sourcePath: string, targetPath: string): Promise<void> {
	if (!(await pathExists(sourcePath))) {
		return;
	}
	try {
		await symlink(sourcePath, targetPath);
		return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
			throw error;
		}
	}
	if (await seededSymlinkResolvesToExpectedSource(sourcePath, targetPath)) {
		return;
	}
	// 陈旧 / 断链目标：仅删除该软链本身（不 recursive、不跟随目标），再指向新源重建。
	await rm(targetPath, { force: true });
	await symlink(sourcePath, targetPath);
}

// 派生 / 刷新 Kanban 托管的 seeded KIMI_CODE_HOME。幂等：每次启动重建 config.toml（使
// provider/model 保持与全局同步）并确保登录态软链存在。返回 seeded home 路径供设入 env。
export async function seedKanbanManagedKimiCodeHome(processEnv: NodeJS.ProcessEnv): Promise<string> {
	const seededHomePath = getKanbanManagedKimiCodeHome();
	let globalHomePath = resolveGlobalKimiCodeHome(processEnv);
	// 防自引用：若解析出的全局 home 恰为 seeded home（异常继承的 env），回落到默认 `~/.kimi-code`。
	if (globalHomePath === seededHomePath) {
		globalHomePath = join(homedir(), ".kimi-code");
	}

	await mkdir(seededHomePath, { recursive: true });
	// seeded home 承载被复制的 config.toml（可能含 api_key）与登录态软链：锁成 owner-only，防同机它用户探查。
	await chmod(seededHomePath, KIMI_SEEDED_HOME_DIRECTORY_MODE);
	for (const entry of KIMI_SEEDED_HOME_LINKED_ENTRIES) {
		await ensureAuthPassthroughSymlink(join(globalHomePath, entry), join(seededHomePath, entry));
	}

	const globalConfigPath = join(globalHomePath, "config.toml");
	const globalConfig = (await pathExists(globalConfigPath)) ? await readFile(globalConfigPath, "utf8") : "";
	const seededConfig = `${stripTomlHookTables(globalConfig).trimEnd()}\n\n${buildKanbanManagedKimiHooksToml()}`;
	const seededConfigPath = join(seededHomePath, "config.toml");
	await lockedFileSystem.writeTextFileAtomic(seededConfigPath, seededConfig, {});
	// writeTextFileAtomic 经默认 writeFile 权限（umask 下常为 0644）落盘，且内容未变时会跳过写入；
	// 无条件强制 0600，既堵住 api_key 泄漏、也自愈修复此前旧种子留下的 0644 文件。
	await chmod(seededConfigPath, KIMI_SEEDED_CONFIG_FILE_MODE);

	return seededHomePath;
}
