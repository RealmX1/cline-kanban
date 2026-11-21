import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeBoardCard, RuntimeBoardData } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { readBacklogTaskCreationRepositoryBaseline } from "./backlog-task-creation-repository-baseline";

export const backlogTaskStartReadinessFingerprint = (value: unknown) =>
	createHash("sha256")
		.update(
			JSON.stringify(value, (_key, entry: unknown) =>
				entry !== null && typeof entry === "object" && !Array.isArray(entry)
					? Object.fromEntries(
							Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
						)
					: entry,
			),
		)
		.digest("hex");
export function fingerprintBacklogTaskStartReadinessInput(card: RuntimeBoardCard) {
	const {
		backlogTaskStartReadinessReview: _review,
		backlogTaskStartReadinessExecutionRevision: _revision,
		updatedAt: _updatedAt,
		...input
	} = card;
	return backlogTaskStartReadinessFingerprint(input);
}
const gitRead = (repositoryPath: string, args: string[]) =>
	runGit(repositoryPath, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
		timeoutMs: 6000,
		trimStdout: false,
		env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }),
	});

export async function readBacklogTaskRepositoryState(workspaceId: string, repositoryPath: string, baseRef: string) {
	const [currentRepository, head, changes, changesSummary, untracked, references] = await Promise.all([
		readBacklogTaskCreationRepositoryBaseline(workspaceId, repositoryPath, baseRef),
		gitRead(repositoryPath, ["rev-parse", "--verify", "HEAD"]),
		gitRead(repositoryPath, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
		gitRead(repositoryPath, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
		gitRead(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
		gitRead(repositoryPath, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
	]);
	const untrackedFiles = untracked.stdout.split("\0").filter(Boolean);
	const untrackedFingerprints = await Promise.all(
		untrackedFiles.slice(0, 200).map(async (path) => {
			try {
				const absolutePath = await assertRepositoryFilePath(repositoryPath, path);
				const info = await lstat(absolutePath);
				return [
					path,
					info.size <= 2_000_000
						? backlogTaskStartReadinessFingerprint(await readFile(absolutePath, "utf8"))
						: [info.size, info.mtimeMs],
				];
			} catch {
				return [path, "unreadable"];
			}
		}),
	);
	const fingerprint = backlogTaskStartReadinessFingerprint([
		currentRepository.gitCommonDirectoryPath,
		currentRepository.commit,
		baseRef,
		head.stdout,
		changes.stdout,
		untracked.stdout,
		untrackedFingerprints,
		references.stdout,
	]);
	return {
		currentRepository,
		headCommit: head.ok ? head.stdout.trim() : null,
		hasWorkingTreeChanges: Boolean(changes.stdout || untracked.stdout),
		fingerprint,
		repositoryStateAvailable: Boolean(
			head.ok &&
				changes.ok &&
				changesSummary.ok &&
				untracked.ok &&
				references.ok &&
				currentRepository.commit &&
				currentRepository.gitCommonDirectoryPath,
		),
		workingChanges: changesSummary.stdout.slice(0, 24000),
		untrackedPaths: untrackedFiles.slice(0, 200),
		uncertaintyReasons: [
			...(!head.ok || !changes.ok || !untracked.ok || !references.ok ? ["当前 Git 状态不完整。"] : []),
			...(untrackedFiles.length > 200 ? ["未跟踪文件超过受限采集范围。"] : []),
			...(currentRepository.unavailableReason ? [currentRepository.unavailableReason] : []),
		],
	};
}

const inFlightBacklogProjectRepositoryObservations = new Map<
	string,
	ReturnType<typeof readBacklogTaskRepositoryState>
>();
export function readSharedBacklogProjectRepositoryObservation(
	workspaceId: string,
	repositoryPath: string,
	baseRef: string,
) {
	const key = JSON.stringify([workspaceId, repositoryPath, baseRef]);
	const existing = inFlightBacklogProjectRepositoryObservations.get(key);
	if (existing) return existing;
	const observation = readBacklogTaskRepositoryState(workspaceId, repositoryPath, baseRef).finally(() =>
		inFlightBacklogProjectRepositoryObservations.delete(key),
	);
	inFlightBacklogProjectRepositoryObservations.set(key, observation);
	return observation;
}

const immutableHistoryComparisons = new Map<
	string,
	Promise<{
		commitCountSinceCreation: number | null;
		commits: string;
		changedRepositoryPaths: string[];
		available: boolean;
	}>
>();
export async function collectBacklogTaskStartReadinessEvidence(input: {
	workspaceId: string;
	repositoryPath: string;
	card: RuntimeBoardCard;
	board: RuntimeBoardData;
}) {
	const { card, repositoryPath, workspaceId, board } = input;
	const [current, executionWorkspace] = await Promise.all([
		readSharedBacklogProjectRepositoryObservation(workspaceId, repositoryPath, card.baseRef),
		getTaskWorkspacePathInfo({
			cwd: repositoryPath,
			taskId: card.id,
			baseRef: card.baseRef,
			worktreeMode: card.worktreeMode,
		}),
	]);
	const executionRepository =
		executionWorkspace.path === repositoryPath
			? current
			: executionWorkspace.exists
				? await readBacklogTaskRepositoryState(workspaceId, executionWorkspace.path, card.baseRef)
				: null;
	const baseline = card.backlogTaskCreationRepositoryBaseline;
	const reasons = [...current.uncertaintyReasons];
	let historyCoverage = "complete";
	if (!baseline?.commit || !baseline.gitCommonDirectoryPath) {
		historyCoverage = "unknown";
		reasons.push("缺少可靠创建基线，按创建时间查找历史仅是替代证据。");
	} else if (
		baseline.gitCommonDirectoryPath !== current.currentRepository.gitCommonDirectoryPath ||
		baseline.workspaceId !== workspaceId
	) {
		historyCoverage = "repository_changed";
		reasons.push("仓库或项目归属已变化，原创建基线不代表当前仓库。");
	} else if (baseline.baseRef !== card.baseRef) {
		historyCoverage = "base_ref_changed";
		reasons.push("所选 baseRef 已变化，须核对当前基线与剩余工作。");
	}
	const comparisonKey = backlogTaskStartReadinessFingerprint([
		repositoryPath,
		baseline?.commit,
		current.currentRepository.commit,
		historyCoverage === "complete" ? null : card.createdAt,
		historyCoverage,
	]);
	let comparison = immutableHistoryComparisons.get(comparisonKey);
	if (!comparison) {
		comparison = (async () => {
			const target = current.currentRepository.commit;
			if (!target)
				return { commitCountSinceCreation: null, commits: "", changedRepositoryPaths: [], available: false };
			const range = historyCoverage === "complete" && baseline?.commit ? `${baseline.commit}..${target}` : target;
			const [ancestor, count, log, paths] = await Promise.all([
				baseline?.commit
					? gitRead(repositoryPath, ["merge-base", "--is-ancestor", baseline.commit, target])
					: Promise.resolve(null),
				gitRead(repositoryPath, [
					"rev-list",
					"--count",
					...(historyCoverage === "complete" ? [] : [`--since=${new Date(card.createdAt).toISOString()}`]),
					range,
				]),
				gitRead(repositoryPath, [
					"log",
					"-100",
					"--format=%H %aI %s",
					...(historyCoverage === "complete" ? [] : [`--since=${new Date(card.createdAt).toISOString()}`]),
					range,
					"--",
				]),
				baseline?.commit
					? gitRead(repositoryPath, [
							"diff",
							"--name-only",
							"--no-ext-diff",
							"--no-textconv",
							baseline.commit,
							target,
							"--",
						])
					: gitRead(repositoryPath, ["ls-tree", "-r", "--name-only", target]),
			]);
			return {
				commitCountSinceCreation: count.ok ? Number(count.stdout.trim()) : null,
				commits: log.stdout.slice(0, 18000),
				changedRepositoryPaths: paths.stdout.trim().split("\n").filter(Boolean).slice(0, 300),
				available: Boolean(ancestor?.ok && count.ok && log.ok && paths.ok),
			};
		})();
		if (immutableHistoryComparisons.size >= 32) immutableHistoryComparisons.clear();
		comparison = comparison.then((result) => {
			if (!result.available) immutableHistoryComparisons.delete(comparisonKey);
			return result;
		});
		immutableHistoryComparisons.set(comparisonKey, comparison);
	}
	const history = await comparison;
	if (historyCoverage === "complete" && !history.available) {
		historyCoverage = "unknown";
		reasons.push("创建 commit 不可读或历史分叉，不能据此断言没有漂移。");
	}
	const relatedTaskSummaries = collectRelatedBacklogTaskWorkSummaries(board, card);
	return {
		...current,
		executionRepositoryPath: executionWorkspace.path,
		executionRepository,
		...history,
		historyCoverage,
		uncertaintyReasons: reasons,
		taskAgeMs: Math.max(0, Date.now() - card.createdAt),
		relatedTaskSummaries,
		projectTaskSummaryCoverage: "最新创建的至多 80 项；列状态不证明已合入；定向查证才读取其他任务工作树。",
	};
}

export function collectRelatedBacklogTaskWorkSummaries(board: RuntimeBoardData, card: RuntimeBoardCard) {
	return board.columns
		.flatMap((column) =>
			column.cards
				.filter((candidate) => candidate.id !== card.id)
				.map((candidate) => ({
					taskId: candidate.id,
					column: column.id,
					title: candidate.title,
					taskDescription: candidate.taskDescription?.slice(0, 1000),
					createdAt: candidate.createdAt,
					updatedAt: candidate.updatedAt,
					workDescriptionFingerprint: backlogTaskStartReadinessFingerprint([
						candidate.prompt,
						candidate.title,
						candidate.taskDescription,
						candidate.baseRef,
						candidate.backlogTaskStartReadinessConditionsText,
					]),
					integrationStatus: column.id === "backlog" ? "not_started" : "requires_git_verification",
				})),
		)
		.sort((left, right) => right.createdAt - left.createdAt || left.taskId.localeCompare(right.taskId))
		.slice(0, 80);
}

export function fingerprintRelatedBacklogTaskWorkSummaries(summaries: unknown) {
	const entries: unknown[] = Array.isArray(summaries) ? summaries : [];
	return backlogTaskStartReadinessFingerprint(
		entries.map((entry) =>
			entry && typeof entry === "object" && "taskId" in entry && "workDescriptionFingerprint" in entry
				? [entry.taskId, entry.workDescriptionFingerprint]
				: null,
		),
	);
}

function assertNonSensitiveRepositoryRelativePath(path: string) {
	if (
		isAbsolute(path) ||
		path
			.split(/[\\/]/u)
			.some((part) => /^(?:\.\.|\.git|\.env(?:\..*)?|auth\.json|credentials.*|id_rsa|id_ed25519)$/iu.test(part))
	)
		throw new Error("只允许读取仓库内非敏感文件。");
}

async function assertRepositoryFilePath(repositoryPath: string, path: string) {
	assertNonSensitiveRepositoryRelativePath(path);
	const root = await realpath(repositoryPath);
	const destination = await realpath(resolve(root, path));
	const relativePath = relative(root, destination);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
		throw new Error("只读路径超出仓库范围。");
	assertNonSensitiveRepositoryRelativePath(relativePath);
	if (!(await lstat(destination)).isFile()) throw new Error("只允许读取普通文件。");
	return destination;
}

export async function readRestrictedBacklogTaskReadinessEvidence(input: {
	repositoryPath: string;
	projectRepositoryPath?: string;
	board: RuntimeBoardData;
	kind: string;
	reference: string;
}) {
	const { repositoryPath, kind, reference, board } = input;
	try {
		if (kind === "read_task" || kind === "read_task_git_changes") {
			const column = board.columns.find((entry) => entry.cards.some((card) => card.id === reference));
			const card = column?.cards.find((candidate) => candidate.id === reference);
			if (!card) throw new Error("当前项目不存在该任务。");
			if (kind === "read_task")
				return {
					reference: `task:${reference}`,
					content: JSON.stringify({
						column: column?.id,
						taskId: card.id,
						title: card.title,
						prompt: card.prompt,
						taskDescription: card.taskDescription,
						backlogTaskStartReadinessConditionsText: card.backlogTaskStartReadinessConditionsText,
						createdAt: card.createdAt,
						updatedAt: card.updatedAt,
					}).slice(0, 18000),
				};
			const info = await getTaskWorkspacePathInfo({
				cwd: input.projectRepositoryPath ?? repositoryPath,
				taskId: reference,
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
			});
			if (!info.exists) throw new Error("该任务没有保留工作树；列状态不证明已落地。");
			const [commits, changes, workingDiff] = await Promise.all([
				gitRead(info.path, ["log", "-30", "--format=%H %s", `${card.baseRef}..HEAD`, "--"]),
				gitRead(info.path, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD", "--"]),
				gitRead(info.path, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD", "--"]),
			]);
			return {
				reference: `task-git:${reference}`,
				available: commits.ok && changes.ok && workingDiff.ok,
				content: JSON.stringify({
					commits: commits.stdout,
					uncommittedChanges: changes.stdout,
					workingChangesFingerprint: backlogTaskStartReadinessFingerprint(workingDiff.stdout),
					coverage: "仅显示尚未合入当前 baseRef 的提交及工作树改动；查询失败保持未知。",
					available: commits.ok && changes.ok && workingDiff.ok,
				}).slice(0, 18000),
			};
		}
		if (kind === "search_repository") {
			const result = await gitRead(repositoryPath, [
				"grep",
				"-I",
				"-n",
				"-F",
				"-e",
				reference,
				"--",
				".",
				":(exclude)*.lock",
				":(exclude)*.env*",
				":(exclude)*auth.json",
				":(exclude)*credentials*",
			]);
			return {
				reference: `search:${reference}`,
				content: result.stdout.slice(0, 18000),
				available: result.ok || result.exitCode === 1,
			};
		}
		if (kind !== "read_repository_file") throw new Error("不支持的只读操作。");
		const path = await assertRepositoryFilePath(repositoryPath, reference);
		if ((await lstat(path)).size > 256000) throw new Error("文件超过只读采集大小限制。");
		return { reference: `file:${reference}`, content: (await readFile(path, "utf8")).slice(0, 18000) };
	} catch (error) {
		return { reference, unavailableReason: error instanceof Error ? error.message : String(error) };
	}
}
