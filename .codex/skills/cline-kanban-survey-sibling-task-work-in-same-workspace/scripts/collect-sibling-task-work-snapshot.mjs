#!/usr/bin/env node
// 只读采集同一个 kanban workspace（= 一个 git repository）内其它任务的在办工作，输出 canonical JSON。
//
// 只读边界由 runReadOnlyGit 的 allowlist 在运行时强制，不只是文档约定：
// 已提交历史一律在项目主 checkout 里借共享 object database 读取，绝不进入 sibling worktree；
// 唯一需要触碰 sibling worktree 的是未提交 WIP，且必须走 --no-optional-locks + GIT_OPTIONAL_LOCKS=0，
// 否则会与该任务正在运行的 agent 抢 index lock。

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_ACTIVE_COLUMNS = ["backlog", "in_progress", "review", "validation"];
const DEFAULT_PER_COMMAND_TIMEOUT_SECONDS = 100;
const DEFAULT_PROMPT_EXCERPT_LENGTH = 400;
const DEFAULT_MAX_UNCOMMITTED_PATHS = 200;
const DEFAULT_MAX_COMMITS_PER_SIBLING_TASK = 50;
const DEFAULT_MAX_COMMITTED_PATHS_PER_SIBLING_TASK = 200;

// 允许出现的 git 子命令。任何写操作（fetch/checkout/add/stash/gc/worktree prune/config…）都不在此列。
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"cat-file",
	"diff",
	"log",
	"merge-base",
	"rev-list",
	"rev-parse",
	"show-ref",
	"status",
	"worktree",
]);
const READ_ONLY_GIT_WORKTREE_VERBS = new Set(["list"]);

// PATH 上可能存在多个同名 `kanban`，未必都是这个看板。候选必须证明自己属于 kanban 包
// （realpath 落在包内，或向上能找到 name 为 kanban 的 manifest），否则宁可降级也不采信其输出。
const KANBAN_CLI_IDENTITY_PATH_FRAGMENT = `${sep}node_modules${sep}kanban${sep}`;
const KANBAN_PACKAGE_NAME = "kanban";

class SnapshotArgumentError extends Error {}

function parseArguments(argumentList) {
	const parsed = {
		projectPath: null,
		selfTaskId: process.env.KANBAN_TASK_ID ?? null,
		baseRef: "main",
		kanbanCliPath: process.env.KANBAN_CLI_PATH ?? null,
		clineHome: null,
		taskWorktreeRoot: null,
		columns: [...DEFAULT_ACTIVE_COLUMNS],
		perCommandTimeoutSeconds: DEFAULT_PER_COMMAND_TIMEOUT_SECONDS,
		promptExcerptLength: DEFAULT_PROMPT_EXCERPT_LENGTH,
		maxUncommittedPaths: DEFAULT_MAX_UNCOMMITTED_PATHS,
	};
	for (let index = 0; index < argumentList.length; index += 1) {
		const name = argumentList[index];
		const readValue = () => {
			const value = argumentList[index + 1];
			if (value === undefined) throw new SnapshotArgumentError(`${name} 缺少取值`);
			index += 1;
			return value;
		};
		switch (name) {
			case "--project-path":
				parsed.projectPath = readValue();
				break;
			case "--self-task-id":
				parsed.selfTaskId = readValue();
				break;
			case "--base-ref":
				parsed.baseRef = readValue();
				break;
			case "--kanban-cli":
				parsed.kanbanCliPath = readValue();
				break;
			case "--cline-home":
				parsed.clineHome = readValue();
				break;
			case "--task-worktree-root":
				parsed.taskWorktreeRoot = readValue();
				break;
			case "--columns":
				parsed.columns = readValue()
					.split(",")
					.map((column) => column.trim())
					.filter((column) => column.length > 0);
				break;
			case "--per-command-timeout-seconds":
				parsed.perCommandTimeoutSeconds = Number.parseInt(readValue(), 10);
				break;
			case "--prompt-excerpt-length":
				parsed.promptExcerptLength = Number.parseInt(readValue(), 10);
				break;
			case "--max-uncommitted-paths":
				parsed.maxUncommittedPaths = Number.parseInt(readValue(), 10);
				break;
			default:
				throw new SnapshotArgumentError(`未知参数: ${name}`);
		}
	}
	if (!parsed.projectPath) throw new SnapshotArgumentError("必须提供 --project-path");
	if (!Number.isInteger(parsed.perCommandTimeoutSeconds) || parsed.perCommandTimeoutSeconds <= 0) {
		throw new SnapshotArgumentError("--per-command-timeout-seconds 必须是正整数");
	}
	parsed.clineHome = parsed.clineHome ?? join(homedir(), ".cline");
	parsed.taskWorktreeRoot = parsed.taskWorktreeRoot ?? join(parsed.clineHome, "worktrees");
	if (parsed.columns.length === 0) throw new SnapshotArgumentError("--columns 不能为空");
	return parsed;
}

function createReadOnlyChildProcessEnvironment() {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
	};
}

function assertReadOnlyGitSubcommand(subcommandArguments) {
	const subcommand = subcommandArguments[0];
	if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
		throw new Error(`拒绝执行非只读 git 子命令: ${subcommand}`);
	}
	if (subcommand === "worktree" && !READ_ONLY_GIT_WORKTREE_VERBS.has(subcommandArguments[1])) {
		throw new Error(`拒绝执行非只读 git worktree 动作: ${subcommandArguments[1]}`);
	}
}

function runReadOnlyGit(workingDirectoryPath, subcommandArguments, options) {
	assertReadOnlyGitSubcommand(subcommandArguments);
	const result = spawnSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"--no-optional-locks",
			"-C",
			workingDirectoryPath,
			...subcommandArguments,
		],
		{
			encoding: "utf8",
			timeout: options.timeoutSeconds * 1000,
			maxBuffer: 64 * 1024 * 1024,
			env: createReadOnlyChildProcessEnvironment(),
		},
	);
	return {
		ok: result.status === 0,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
		timedOut: result.signal !== null && result.status === null,
		failureReason: result.error ? String(result.error.message) : null,
	};
}

function gitOutputLines(text) {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function resolveRealPathOrSelf(candidatePath) {
	try {
		return realpathSync(candidatePath);
	} catch {
		return resolve(candidatePath);
	}
}

function resolveProjectMainCheckoutPath(projectPath, timeoutSeconds) {
	const worktreeListing = runReadOnlyGit(projectPath, ["worktree", "list", "--porcelain"], { timeoutSeconds });
	if (!worktreeListing.ok) return null;
	for (const line of gitOutputLines(worktreeListing.stdout)) {
		// git 保证主 worktree 是 porcelain 列表里的第一条。
		if (line.startsWith("worktree ")) return resolveRealPathOrSelf(line.slice("worktree ".length));
	}
	return null;
}

function parseWorktreeListing(porcelainText) {
	const entries = [];
	let current = null;
	for (const line of porcelainText.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { worktreePath: line.slice("worktree ".length), headOid: null, branch: null, detached: false };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.headOid = line.slice("HEAD ".length).trim();
		else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim();
		else if (line.trim() === "detached") current.detached = true;
	}
	return entries;
}

function deriveTaskIdFromWorktreePath(worktreePath, taskWorktreeRootRealPath) {
	const normalized = resolveRealPathOrSelf(worktreePath);
	const prefix = taskWorktreeRootRealPath.endsWith(sep) ? taskWorktreeRootRealPath : taskWorktreeRootRealPath + sep;
	if (!normalized.startsWith(prefix)) return null;
	const [firstSegment] = normalized.slice(prefix.length).split(sep);
	return firstSegment && firstSegment.length > 0 ? firstSegment : null;
}

// kanban 的 task prompt 里偶尔混入未转义控制字符，会让严格 JSON.parse 直接失败。
function parseKanbanJsonText(rawText) {
	try {
		return { ok: true, value: JSON.parse(rawText) };
	} catch {
		/* 落到下面的控制字符净化重试 */
	}
	const VALID_JSON_ESCAPE_CHARACTERS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
	let sanitized = "";
	let insideString = false;
	for (let index = 0; index < rawText.length; index += 1) {
		const character = rawText[index];
		if (!insideString) {
			if (character === '"') insideString = true;
			sanitized += character;
			continue;
		}
		if (character === "\\") {
			// 裸反斜杠后面若跟着控制字符，两个字符都是坏的；把反斜杠本身转义掉再重新审视下一个字符。
			const nextCharacter = rawText[index + 1];
			if (nextCharacter !== undefined && VALID_JSON_ESCAPE_CHARACTERS.has(nextCharacter)) {
				sanitized += character + nextCharacter;
				index += 1;
			} else {
				sanitized += "\\\\";
			}
			continue;
		}
		if (character === '"') {
			insideString = false;
			sanitized += character;
			continue;
		}
		const codeUnit = character.charCodeAt(0);
		sanitized += codeUnit < 0x20 ? `\\u${codeUnit.toString(16).padStart(4, "0")}` : character;
	}
	try {
		return { ok: true, value: JSON.parse(sanitized) };
	} catch (error) {
		return { ok: false, failureReason: String(error?.message ?? error) };
	}
}

function listExecutableCandidatesNamed(commandName) {
	const candidates = [];
	for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
		if (!pathEntry) continue;
		const candidate = join(pathEntry, commandName);
		if (existsSync(candidate)) candidates.push(candidate);
	}
	return candidates;
}

function isKanbanPackageBinary(candidatePath) {
	const realPath = resolveRealPathOrSelf(candidatePath);
	if (realPath.includes(KANBAN_CLI_IDENTITY_PATH_FRAGMENT)) return true;
	// npm link 的本地开发装法会让 realpath 落到源码 checkout 里，路径片段认不出来，只能读 manifest 的 name。
	let directoryPath = dirname(realPath);
	for (let depth = 0; depth < 4; depth += 1) {
		const packageManifestPath = join(directoryPath, "package.json");
		if (existsSync(packageManifestPath)) {
			try {
				if (JSON.parse(readFileSync(packageManifestPath, "utf8"))?.name === KANBAN_PACKAGE_NAME) return true;
			} catch {
				/* 损坏的 manifest 不作为身份证据 */
			}
		}
		const parentDirectoryPath = dirname(directoryPath);
		if (parentDirectoryPath === directoryPath) break;
		directoryPath = parentDirectoryPath;
	}
	return false;
}

function identifyKanbanCliPath(explicitPath) {
	const inspected = [];
	const candidates = explicitPath ? [explicitPath] : listExecutableCandidatesNamed("kanban");
	for (const candidate of candidates) {
		if (!existsSync(candidate)) {
			inspected.push({ candidatePath: candidate, verdict: "MISSING" });
			continue;
		}
		// 显式传入的路径以调用方判断为准（测试桩就走这条），自动发现的必须证明身份。
		if (explicitPath || isKanbanPackageBinary(candidate)) return { kanbanCliPath: candidate, inspected };
		inspected.push({ candidatePath: candidate, verdict: "NOT_A_KANBAN_PACKAGE_BINARY" });
	}
	return { kanbanCliPath: null, inspected };
}

// kanban CLI 的 stdout 走管道时会在 ~56KB 处静默截断（子进程未 flush 完就退出），落到文件描述符
// 则完整。因此这里必须重定向到临时文件再读，绝不能直接吃 spawnSync 的 pipe stdout。
function readTaskInventoryFromKanbanCli(kanbanCliPath, projectPath, timeoutSeconds) {
	const temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-sibling-task-work-snapshot-"));
	const capturedStdoutPath = join(temporaryDirectoryPath, "task-list.json");
	let capturedStdoutText = "";
	try {
		const capturedStdoutFileDescriptor = openSync(capturedStdoutPath, "w");
		try {
			const executed = spawnSync(kanbanCliPath, ["task", "list", "--project-path", projectPath], {
				timeout: timeoutSeconds * 1000,
				env: createReadOnlyChildProcessEnvironment(),
				stdio: ["ignore", capturedStdoutFileDescriptor, "pipe"],
			});
			if (executed.error) return { ok: false, failureReason: String(executed.error.message) };
			if (executed.status !== 0) return { ok: false, failureReason: `kanban CLI 退出码 ${executed.status}` };
		} finally {
			closeSync(capturedStdoutFileDescriptor);
		}
		capturedStdoutText = readFileSync(capturedStdoutPath, "utf8");
	} finally {
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
	const parsed = parseKanbanJsonText(capturedStdoutText);
	if (!parsed.ok) return { ok: false, failureReason: `kanban CLI 输出无法解析: ${parsed.failureReason}` };
	const tasks = Array.isArray(parsed.value?.tasks) ? parsed.value.tasks : null;
	if (!tasks) return { ok: false, failureReason: "kanban CLI 输出缺少 tasks 数组" };
	return { ok: true, tasks, dependencies: parsed.value?.dependencies ?? null };
}

function readTaskInventoryFromDurableBoardState(clineHome, workspaceId) {
	if (!workspaceId) return { ok: false, failureReason: "未能解析 workspaceId" };
	const boardPath = join(clineHome, "kanban", "workspaces", workspaceId, "board.json");
	if (!existsSync(boardPath)) return { ok: false, failureReason: `durable board.json 不存在: ${boardPath}` };
	const parsed = parseKanbanJsonText(readFileSync(boardPath, "utf8"));
	if (!parsed.ok) return { ok: false, failureReason: `durable board.json 无法解析: ${parsed.failureReason}` };
	const columns = Array.isArray(parsed.value?.columns) ? parsed.value.columns : [];
	const tasks = [];
	for (const column of columns) {
		const columnId = column?.id ?? column?.name ?? null;
		for (const task of Array.isArray(column?.tasks) ? column.tasks : []) {
			tasks.push({ ...task, column: task?.column ?? columnId });
		}
	}
	const sessionsPath = join(clineHome, "kanban", "workspaces", workspaceId, "sessions.json");
	if (existsSync(sessionsPath)) {
		const parsedSessions = parseKanbanJsonText(readFileSync(sessionsPath, "utf8"));
		const sessionsById = parsedSessions.ok ? (parsedSessions.value ?? {}) : {};
		for (const task of tasks) {
			if (!task.session && task.id && sessionsById[task.id]) task.session = sessionsById[task.id];
		}
	}
	return { ok: true, tasks, dependencies: parsed.value?.dependencies ?? null };
}

function resolveWorkspaceId(clineHome, projectMainCheckoutPath) {
	const indexPath = join(clineHome, "kanban", "workspaces", "index.json");
	if (!existsSync(indexPath)) return null;
	const parsed = parseKanbanJsonText(readFileSync(indexPath, "utf8"));
	if (!parsed.ok) return null;
	const entries = parsed.value?.entries ?? {};
	for (const [workspaceId, entry] of Object.entries(entries)) {
		if (!entry?.repoPath) continue;
		if (resolveRealPathOrSelf(entry.repoPath) === projectMainCheckoutPath) return workspaceId;
	}
	return null;
}

function buildPromptExcerpt(prompt, excerptLength) {
	if (typeof prompt !== "string") return "";
	const collapsed = prompt.replace(/\s+/g, " ").trim();
	return collapsed.length <= excerptLength ? collapsed : `${collapsed.slice(0, excerptLength)}…`;
}

function readCommittedWorkFromSharedObjectDatabase(projectMainCheckoutPath, baseRef, headOid, timeoutSeconds) {
	const containedInLocalBase = runReadOnlyGit(
		projectMainCheckoutPath,
		["merge-base", "--is-ancestor", headOid, baseRef],
		{ timeoutSeconds },
	);
	const commitListing = runReadOnlyGit(
		projectMainCheckoutPath,
		["log", `--max-count=${DEFAULT_MAX_COMMITS_PER_SIBLING_TASK}`, "--format=%H%x1f%s", `${baseRef}..${headOid}`],
		{ timeoutSeconds },
	);
	const commitsAheadOfLocalBase = commitListing.ok
		? gitOutputLines(commitListing.stdout).map((line) => {
				const [oid, subject] = line.split("\u001f");
				return { oid, subject: subject ?? "" };
			})
		: [];
	const changedPathListing = runReadOnlyGit(
		projectMainCheckoutPath,
		["diff", "--name-only", `${baseRef}...${headOid}`],
		{ timeoutSeconds },
	);
	const committedPaths = changedPathListing.ok ? gitOutputLines(changedPathListing.stdout).sort() : [];
	return {
		headContainedInLocalBase: containedInLocalBase.ok,
		commitsAheadOfLocalBase,
		committedPaths: committedPaths.slice(0, DEFAULT_MAX_COMMITTED_PATHS_PER_SIBLING_TASK),
		committedPathsTruncated: committedPaths.length > DEFAULT_MAX_COMMITTED_PATHS_PER_SIBLING_TASK,
	};
}

function readUncommittedWorkFromSiblingWorktree(worktreePath, timeoutSeconds, maxUncommittedPaths) {
	const statusResult = runReadOnlyGit(worktreePath, ["status", "--porcelain", "--untracked-files=normal"], {
		timeoutSeconds,
	});
	if (!statusResult.ok) {
		return {
			uncommittedReadStatus: statusResult.timedOut ? "TIMED_OUT" : "ERROR",
			uncommittedPaths: [],
			uncommittedPathCount: 0,
			uncommittedPathsTruncated: false,
		};
	}
	const paths = gitOutputLines(statusResult.stdout)
		.map((line) => {
			const payload = line.slice(3);
			const renameSeparatorIndex = payload.indexOf(" -> ");
			return renameSeparatorIndex >= 0 ? payload.slice(renameSeparatorIndex + 4) : payload;
		})
		.map((path) => path.replace(/^"(.*)"$/, "$1"))
		.sort();
	return {
		uncommittedReadStatus: "READ",
		uncommittedPaths: paths.slice(0, maxUncommittedPaths),
		uncommittedPathCount: paths.length,
		uncommittedPathsTruncated: paths.length > maxUncommittedPaths,
	};
}

function isSessionActive(session) {
	if (!session) return false;
	if (session.liveness === "live") return true;
	return session.state === "running";
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const timeoutSeconds = options.perCommandTimeoutSeconds;
	const degradations = [];

	const projectPathRealPath = resolveRealPathOrSelf(options.projectPath);
	if (!existsSync(projectPathRealPath) || !statSync(projectPathRealPath).isDirectory()) {
		throw new SnapshotArgumentError(`--project-path 不是可访问目录: ${options.projectPath}`);
	}
	const projectMainCheckoutPath = resolveProjectMainCheckoutPath(projectPathRealPath, timeoutSeconds);
	if (!projectMainCheckoutPath) throw new SnapshotArgumentError(`--project-path 不在 git 仓库内: ${options.projectPath}`);

	const clineHome = resolveRealPathOrSelf(options.clineHome);
	const taskWorktreeRootRealPath = resolveRealPathOrSelf(options.taskWorktreeRoot);
	const workspaceId = resolveWorkspaceId(clineHome, projectMainCheckoutPath);
	if (!workspaceId) degradations.push({ stage: "WORKSPACE_ID", reason: "kanban workspace 索引里没有匹配该仓库的条目" });

	const baseTipResult = runReadOnlyGit(projectMainCheckoutPath, ["rev-parse", "--verify", `refs/heads/${options.baseRef}`], {
		timeoutSeconds,
	});
	const localBaseRefPresent = baseTipResult.ok;
	const localBaseTip = localBaseRefPresent ? baseTipResult.stdout.trim() : null;
	if (!localBaseRefPresent) {
		degradations.push({ stage: "LOCAL_BASE_REF", reason: `本地 base ref 不存在: refs/heads/${options.baseRef}` });
	}

	const worktreeListing = runReadOnlyGit(projectMainCheckoutPath, ["worktree", "list", "--porcelain"], {
		timeoutSeconds,
	});
	const worktreeEntries = worktreeListing.ok ? parseWorktreeListing(worktreeListing.stdout) : [];
	if (!worktreeListing.ok) degradations.push({ stage: "WORKTREE_LISTING", reason: "git worktree list 失败" });

	const worktreeByTaskId = new Map();
	for (const entry of worktreeEntries) {
		const taskId = deriveTaskIdFromWorktreePath(entry.worktreePath, taskWorktreeRootRealPath);
		if (!taskId) continue;
		worktreeByTaskId.set(taskId, { ...entry, worktreePath: resolveRealPathOrSelf(entry.worktreePath) });
	}

	const { kanbanCliPath, inspected: inspectedKanbanCliCandidates } = identifyKanbanCliPath(options.kanbanCliPath);
	let taskInventorySource = null;
	let inventory = { ok: false, tasks: [], dependencies: null };
	if (kanbanCliPath) {
		inventory = readTaskInventoryFromKanbanCli(kanbanCliPath, projectMainCheckoutPath, timeoutSeconds);
		if (inventory.ok) taskInventorySource = "KANBAN_CLI";
		else degradations.push({ stage: "KANBAN_CLI", reason: inventory.failureReason });
	} else {
		degradations.push({
			stage: "KANBAN_CLI",
			reason: `未能确认 kanban CLI 身份，检查过的候选: ${JSON.stringify(inspectedKanbanCliCandidates)}`,
		});
	}
	if (!taskInventorySource) {
		inventory = readTaskInventoryFromDurableBoardState(clineHome, workspaceId);
		if (inventory.ok) taskInventorySource = "DURABLE_BOARD_STATE";
		else degradations.push({ stage: "DURABLE_BOARD_STATE", reason: inventory.failureReason });
	}
	if (taskInventorySource === "DURABLE_BOARD_STATE" && inventory.tasks.length === 0) {
		// durable 层实测可能为空；空不等于「没有其它任务」，必须继续降级到 git 层。
		degradations.push({ stage: "DURABLE_BOARD_STATE", reason: "durable board.json 里没有任何任务记录" });
		taskInventorySource = null;
	}
	if (!taskInventorySource) {
		taskInventorySource = "GIT_WORKTREE_ONLY";
		inventory = { ok: true, tasks: [], dependencies: null };
	}

	const selfWorktreeRealPath = resolveRealPathOrSelf(process.cwd());
	const isSelf = (taskId, worktreePath) => {
		if (options.selfTaskId && taskId === options.selfTaskId) return true;
		return Boolean(worktreePath) && worktreePath === selfWorktreeRealPath;
	};

	const activeColumns = new Set(options.columns);
	const siblingTasks = [];
	const accountedTaskIds = new Set();

	for (const task of inventory.tasks) {
		const taskId = task?.id;
		if (!taskId) continue;
		accountedTaskIds.add(taskId);
		if (!activeColumns.has(task?.column)) continue;
		const worktree = worktreeByTaskId.get(taskId) ?? null;
		if (isSelf(taskId, worktree?.worktreePath ?? null)) continue;
		const session = task?.session ?? null;
		const record = {
			taskId,
			column: task?.column ?? null,
			baseRef: task?.baseRef ?? null,
			promptExcerpt: buildPromptExcerpt(task?.prompt, options.promptExcerptLength),
			promptLength: typeof task?.prompt === "string" ? task.prompt.length : 0,
			sessionState: session?.state ?? null,
			sessionLiveness: session?.liveness ?? null,
			sessionTurnOwner: session?.turnOwner ?? null,
			sessionActive: isSessionActive(session),
			worktreePresent: Boolean(worktree),
			worktreePath: worktree?.worktreePath ?? null,
			headOid: worktree?.headOid ?? null,
			headContainedInLocalBase: null,
			commitsAheadOfLocalBase: [],
			committedPaths: [],
			committedPathsTruncated: false,
			uncommittedReadStatus: "NOT_ATTEMPTED_WORKTREE_ABSENT",
			uncommittedPaths: [],
			uncommittedPathCount: 0,
			uncommittedPathsTruncated: false,
		};
		if (worktree?.headOid && localBaseRefPresent) {
			Object.assign(
				record,
				readCommittedWorkFromSharedObjectDatabase(
					projectMainCheckoutPath,
					options.baseRef,
					worktree.headOid,
					timeoutSeconds,
				),
			);
		}
		if (worktree?.worktreePath) {
			Object.assign(
				record,
				readUncommittedWorkFromSiblingWorktree(worktree.worktreePath, timeoutSeconds, options.maxUncommittedPaths),
			);
		}
		siblingTasks.push(record);
	}

	const orphanWorktreesWithoutActiveTask = [];
	for (const [taskId, worktree] of worktreeByTaskId) {
		if (accountedTaskIds.has(taskId)) continue;
		if (isSelf(taskId, worktree.worktreePath)) continue;
		const committed =
			worktree.headOid && localBaseRefPresent
				? readCommittedWorkFromSharedObjectDatabase(
						projectMainCheckoutPath,
						options.baseRef,
						worktree.headOid,
						timeoutSeconds,
					)
				: { headContainedInLocalBase: null, commitsAheadOfLocalBase: [] };
		if (taskInventorySource === "GIT_WORKTREE_ONLY") {
			// 没有任务清单可用时，worktree 就是唯一的 sibling 证据，不能被降级成 orphan 而丢失。
			siblingTasks.push({
				taskId,
				column: null,
				baseRef: null,
				promptExcerpt: "",
				promptLength: 0,
				sessionState: null,
				sessionLiveness: null,
				sessionTurnOwner: null,
				sessionActive: false,
				worktreePresent: true,
				worktreePath: worktree.worktreePath,
				headOid: worktree.headOid,
				headContainedInLocalBase: committed.headContainedInLocalBase,
				commitsAheadOfLocalBase: committed.commitsAheadOfLocalBase,
				committedPaths: committed.committedPaths ?? [],
				committedPathsTruncated: committed.committedPathsTruncated ?? false,
				...readUncommittedWorkFromSiblingWorktree(
					worktree.worktreePath,
					timeoutSeconds,
					options.maxUncommittedPaths,
				),
			});
			continue;
		}
		orphanWorktreesWithoutActiveTask.push({
			taskId,
			worktreePath: worktree.worktreePath,
			headOid: worktree.headOid,
			headContainedInLocalBase: committed.headContainedInLocalBase,
			commitCountAheadOfLocalBase: committed.commitsAheadOfLocalBase.length,
		});
	}

	siblingTasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
	orphanWorktreesWithoutActiveTask.sort((left, right) => left.taskId.localeCompare(right.taskId));

	const snapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		workspaceId,
		projectMainCheckoutPath,
		baseRef: options.baseRef,
		localBaseRefPresent,
		localBaseTip,
		selfTaskId: options.selfTaskId,
		taskInventorySource,
		taskInventoryDegraded: taskInventorySource !== "KANBAN_CLI",
		activeColumns: [...options.columns],
		siblingTaskCount: siblingTasks.length,
		siblingTasks,
		taskDependencies: inventory.dependencies ?? null,
		orphanWorktreeCount: orphanWorktreesWithoutActiveTask.length,
		orphanWorktreesWithoutActiveTask,
		degradations,
	};
	process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

try {
	main();
} catch (error) {
	if (error instanceof SnapshotArgumentError) {
		process.stderr.write(`SNAPSHOT_ARGUMENT_ERROR: ${error.message}\n`);
		process.exit(2);
	}
	process.stderr.write(`SNAPSHOT_UNEXPECTED_ERROR: ${String(error?.stack ?? error)}\n`);
	process.exit(1);
}
