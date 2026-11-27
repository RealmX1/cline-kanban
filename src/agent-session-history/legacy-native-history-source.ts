import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	inferCodexHomeDirectoryPathFromTranscriptPath,
	resolveMigratedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import { doesConversationSessionBelongToTask } from "../core/task-main-conversation-session-binding";
import { resolveGitCommonDirectory } from "../state/registered-workspace-invocation-context";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { encodeClaudeProjectDirectoryName } from "./bounded-agent-transcript-reader";
import {
	readCodexThreadRolloutPath,
	readCodexThreadRolloutPathsByWorkingDirectory,
} from "./codex-native-transcript-current-pointer";
import { codexTranscriptJsonlPath } from "./codex-transcript-read-source";
import {
	codexNativeHistoryRolloutFallsInsideWindow,
	inspectLegacyNativeHistoryTranscript,
	type LegacyNativeHistoryAgentId,
	legacyCodexHistoryScanWindow,
	legacyNativeSessionIdPattern,
	requestLegacyNativeHistorySourceScan,
} from "./legacy-native-history-source-scan";

export interface LegacyNativeHistoryWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

type NativeIdentity = NonNullable<RuntimeTaskSessionSummary["agentNativeConversationSessionIdentity"]>;
export interface LegacyNativeHistoryEvidence {
	sourceInstanceId: string;
	workspaceId: string;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	conversationSessionId: string;
	agentId: LegacyNativeHistoryAgentId;
	binding: "known_native_id" | "verified_worktree_and_initial_prompt";
	identity: NativeIdentity;
	workingDirectoryPath: string | null;
	transcriptRevision: string;
}

export function localNativeHistorySourceInstanceId() {
	return createHash("sha256")
		.update(JSON.stringify([hostname(), getRuntimeHomePath()]))
		.digest("hex");
}

export function nativeHistoryOwnershipFingerprint(
	card: RuntimeBoardCard | null | undefined,
	summary: RuntimeTaskSessionSummary | undefined,
	sessions: Record<string, RuntimeTaskSessionSummary>,
) {
	const metadata = summary?.taskConversationSessionMetadata;
	const nativeIdentity = summary?.agentNativeConversationSessionIdentity;
	return JSON.stringify([
		card?.id,
		card?.createdAt,
		card?.prompt,
		card?.worktreeMode,
		card?.mainTaskConversationSessionId,
		summary?.agentId,
		summary?.runtimeSessionIncarnationId,
		summary?.workspacePath,
		nativeIdentity?.sourceAgentId,
		nativeIdentity?.nativeSessionId,
		nativeIdentity?.transcriptPath,
		summary?.codexConversationStorageHomeDirectoryPath,
		metadata?.workspaceTaskId,
		metadata?.taskConversationSessionRole,
		metadata?.taskConversationSessionRoleAtCreation,
		metadata?.taskConversationSessionContextSource,
		metadata?.parentTaskConversationSessionId,
		summary?.taskConversationSessionNativeIdentityRecovery?.forkSourceNativeSessionId,
		card &&
			Object.values(sessions)
				.filter((session) => doesConversationSessionBelongToTask(session, card.id))
				.map((session) => session.taskId)
				.sort(),
	]);
}

function isInsideNativeHistoryDirectory(root: string, path: string) {
	const location = relative(root, path);
	return location !== "" && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

async function verifiedNativeHistoryFile(path: string, roots: string[], agentId: LegacyNativeHistoryAgentId) {
	if (!isAbsolute(path) || !roots.some((root) => isInsideNativeHistoryDirectory(root, path))) return null;
	const alternatives =
		agentId === "codex" ? [path, path.endsWith(".zst") ? codexTranscriptJsonlPath(path) : `${path}.zst`] : [path];
	for (const candidate of alternatives) {
		try {
			const metadata = await lstat(candidate);
			const canonical = await realpath(candidate);
			// 根自身须有相同的物理归属，支持 /var 等系统路径别名。
			for (const root of roots) {
				if (
					metadata.isFile() &&
					isInsideNativeHistoryDirectory(root, candidate) &&
					isInsideNativeHistoryDirectory(await realpath(root), canonical)
				)
					return canonical;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return null;
}

async function verifyLegacyHistoryTaskWorktree(
	scope: LegacyNativeHistoryWorkspaceScope,
	card: RuntimeBoardCard,
	summary: RuntimeTaskSessionSummary,
	sessions: Record<string, RuntimeTaskSessionSummary>,
) {
	const metadata = summary.taskConversationSessionMetadata;
	if (
		summary.taskId !== card.id ||
		card.worktreeMode === "inplace" ||
		(metadata &&
			(metadata.taskConversationSessionRole !== "main" ||
				(metadata.taskConversationSessionRoleAtCreation ?? "main") !== "main" ||
				metadata.taskConversationSessionContextSource !== "main" ||
				metadata.parentTaskConversationSessionId)) ||
		Object.values(sessions).some(
			(other) => other.taskId !== summary.taskId && doesConversationSessionBelongToTask(other, card.id),
		)
	)
		return null;
	try {
		const expected = await getTaskWorkspacePathInfo({
			cwd: scope.workspacePath,
			taskId: card.id,
			baseRef: card.baseRef,
		});
		if (!expected.exists || !(await lstat(join(expected.path, ".git"))).isFile()) return null;
		const [worktree, repository, common, repositoryCommon] = await Promise.all([
			realpath(expected.path),
			realpath(scope.workspacePath),
			resolveGitCommonDirectory(expected.path),
			resolveGitCommonDirectory(scope.workspacePath),
		]);
		if (
			worktree === repository ||
			common !== repositoryCommon ||
			(summary.workspacePath && (await realpath(summary.workspacePath)) !== worktree)
		)
			return null;
		const registered = await runGit(scope.workspacePath, ["worktree", "list", "--porcelain", "-z"], {
			timeoutMs: 3000,
		});
		if (!registered.ok || !registered.stdout.split("\0").includes(`worktree ${worktree}`)) return null;
		return {
			path: worktree,
			aliases: [...new Set([worktree, expected.path, summary.workspacePath ?? expected.path])],
		};
	} catch {
		return null;
	}
}

function normalizeLegacyNativeHistoryPrompt(text: string) {
	return text.replaceAll("\r\n", "\n").trim();
}

function isRootNativeHistoryFile(path: string, nativeSessionId: string, agentId: LegacyNativeHistoryAgentId) {
	const fileName = basename(codexTranscriptJsonlPath(path));
	return agentId === "codex"
		? fileName.endsWith(`-${nativeSessionId}.jsonl`)
		: fileName === `${nativeSessionId}.jsonl`;
}

async function findKnownClaudeHistoryPaths(projectsRoot: string, nativeSessionId: string) {
	const paths: string[] = [];
	try {
		const projects = await opendir(projectsRoot);
		let visited = 0;
		for await (const entry of projects) {
			if (++visited > 10_000) throw new Error("Claude 项目目录超出已知 ID 核验预算。");
			if (entry.isDirectory()) paths.push(join(projectsRoot, entry.name, `${nativeSessionId}.jsonl`));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return paths;
}

export async function resolveLegacyNativeHistorySource(input: {
	scope: LegacyNativeHistoryWorkspaceScope;
	card: RuntimeBoardCard;
	summary: RuntimeTaskSessionSummary;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	waitForScan?: boolean;
}) {
	const { scope, card, summary, sessions } = input;
	const agentId = summary.agentId;
	const knownIdentity = summary.agentNativeConversationSessionIdentity;
	const roots: string[] = [];
	const indexDirectories: string[] = [];
	const candidates: LegacyNativeHistoryEvidence[] = [];
	const unresolvedCandidatePaths = new Set<string>();
	const rejectedCandidates: { transcriptPath: string; nativeSessionId: string; reason: string }[] = [];
	const scanWindow =
		agentId === "codex" && !knownIdentity
			? legacyCodexHistoryScanWindow(
					card.createdAt,
					Math.max(card.createdAt, summary.updatedAt, summary.lastOutputAt ?? 0, summary.startedAt ?? 0),
				)
			: undefined;
	let scanCost = {
		directoryEntriesVisited: 0,
		transcriptFilesRead: 0,
		decodedBytes: 0,
		cachedHeaders: 0,
		reusedDirectoryScans: 0,
		sqliteQueries: 0,
	};
	let directoriesUnavailable = false;
	const result = (
		status:
			| "verified"
			| "ambiguous"
			| "scanning"
			| "search_limited"
			| "no_matching_transcript"
			| "ownership_unproven",
		notice: string,
	) => ({
		status,
		notice,
		roots,
		indexDirectories,
		scanWindow,
		scanCost,
		rejectedCandidates: rejectedCandidates.sort((left, right) =>
			left.transcriptPath.localeCompare(right.transcriptPath, "en"),
		),
		candidates: candidates.map(({ identity, binding }) => ({
			nativeSessionId: identity.nativeSessionId,
			transcriptPath: identity.transcriptPath,
			binding,
		})),
		unresolvedCandidateCount: unresolvedCandidatePaths.size,
		evidence: status === "verified" ? candidates[0] : undefined,
	});
	if (
		(agentId !== "codex" && agentId !== "claude") ||
		!doesConversationSessionBelongToTask(summary, card.id) ||
		summary.updatedAt < card.createdAt ||
		(knownIdentity && knownIdentity.observedAt < card.createdAt) ||
		(knownIdentity &&
			(knownIdentity.sourceAgentId !== agentId || !legacyNativeSessionIdPattern.test(knownIdentity.nativeSessionId)))
	)
		return result("ownership_unproven", "当前会话缺少可核验的原生身份与宿主归属。持久会话绑定变化后重验。");
	const worktree = knownIdentity ? null : await verifyLegacyHistoryTaskWorktree(scope, card, summary, sessions);
	if (
		!knownIdentity &&
		(!worktree || summary.taskConversationSessionNativeIdentityRecovery?.forkSourceNativeSessionId)
	)
		return result(
			"ownership_unproven",
			"现有记录无法证明任务独立工作目录或原会话归属。取得独立绑定或恢复工作树后重验。",
		);
	const observedAt = Math.max(card.createdAt, summary.updatedAt, summary.lastOutputAt ?? 0, summary.startedAt ?? 0);
	const knownSessionId = knownIdentity?.nativeSessionId;
	const indexedPaths = new Set<string>();
	const visitedPaths = new Set<string>();
	const classifyCandidate = async (path: string, acceptCurrentIndexedRollout = false) => {
		try {
			const verifiedPath = await verifiedNativeHistoryFile(path, roots, agentId);
			if (!verifiedPath || visitedPaths.has(verifiedPath)) return;
			visitedPaths.add(verifiedPath);
			scanCost.transcriptFilesRead++;
			const { header, initialPrompt, decodedBytes, incomplete, revision } =
				await inspectLegacyNativeHistoryTranscript(verifiedPath, agentId, !knownSessionId);
			scanCost.decodedBytes += decodedBytes;
			if (incomplete) unresolvedCandidatePaths.add(verifiedPath);
			if (
				!header ||
				incomplete ||
				(knownSessionId && header.nativeSessionId !== knownSessionId) ||
				!(acceptCurrentIndexedRollout || isRootNativeHistoryFile(verifiedPath, header.nativeSessionId, agentId))
			)
				return;
			if (!knownSessionId) {
				if (!header.workingDirectoryPath || !worktree?.aliases.includes(header.workingDirectoryPath)) return;
				if (!Number.isFinite(header.createdAt)) {
					unresolvedCandidatePaths.add(verifiedPath);
					return;
				}
				const rejectionReason =
					header.createdAt < card.createdAt || header.createdAt > observedAt
						? "outside_task_incarnation_observation"
						: !initialPrompt ||
								normalizeLegacyNativeHistoryPrompt(initialPrompt) !==
									normalizeLegacyNativeHistoryPrompt(card.prompt)
							? "initial_prompt_mismatch"
							: header.inheritedHistory
								? "inherited_native_history"
								: null;
				if (rejectionReason) {
					rejectedCandidates.push({
						transcriptPath: verifiedPath,
						nativeSessionId: header.nativeSessionId,
						reason: rejectionReason,
					});
					if (rejectionReason === "inherited_native_history") unresolvedCandidatePaths.add(verifiedPath);
					return;
				}
			}
			candidates.push({
				sourceInstanceId: localNativeHistorySourceInstanceId(),
				workspaceId: scope.workspaceId,
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				conversationSessionId: summary.taskId,
				agentId,
				binding: knownSessionId ? "known_native_id" : "verified_worktree_and_initial_prompt",
				identity: {
					sourceAgentId: agentId,
					nativeSessionId: header.nativeSessionId,
					transcriptPath: verifiedPath,
					observedAt: knownIdentity?.observedAt ?? header.createdAt,
				},
				workingDirectoryPath: worktree?.path ?? summary.workspacePath,
				transcriptRevision: revision,
			});
		} catch {
			unresolvedCandidatePaths.add(path);
		}
	};

	if (agentId === "codex") {
		const recordedHome =
			inferCodexHomeDirectoryPathFromTranscriptPath(knownIdentity?.transcriptPath) ??
			summary.codexConversationStorageHomeDirectoryPath;
		const configuredHome = process.env.CODEX_HOME;
		const homes = [
			...new Set(
				[
					recordedHome,
					getManagedCodexConversationStorageHomeDirectoryPath(),
					join(homedir(), ".codex"),
					configuredHome && isAbsolute(configuredHome) ? configuredHome : undefined,
				].filter((home): home is string => Boolean(home)),
			),
		];
		if (knownSessionId && recordedHome) {
			try {
				const migratedHome = await resolveMigratedCodexConversationHome(recordedHome, knownSessionId);
				if (resolve(migratedHome) !== resolve(recordedHome)) homes.splice(0, homes.length, migratedHome);
			} catch {
				return result("search_limited", "Codex 迁移来源暂不可核验。迁移记录恢复后重验。");
			}
		}
		for (const home of homes) {
			roots.push(join(home, "sessions"), join(home, "archived_sessions"));
			indexDirectories.push(home);
			const database = join(home, "state_5.sqlite");
			try {
				if (knownSessionId) {
					scanCost.sqliteQueries++;
					const path = readCodexThreadRolloutPath(database, knownSessionId);
					if (path) indexedPaths.add(path);
				} else
					for (const cwd of worktree?.aliases ?? []) {
						scanCost.sqliteQueries++;
						const paths = readCodexThreadRolloutPathsByWorkingDirectory(database, cwd);
						for (const path of paths.slice(0, 256)) indexedPaths.add(path);
					}
			} catch {
				// 索引缺失、不可读或落后时，目录扫描提供独立覆盖。
			}
		}
	} else {
		const claudeAccountRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
		const projectsRoot = join(claudeAccountRoot, "projects");
		if (!isAbsolute(claudeAccountRoot))
			return result("ownership_unproven", "Claude 配置根为相对路径，账户归属待证。");
		if (knownSessionId) {
			roots.push(projectsRoot);
			try {
				for (const path of await findKnownClaudeHistoryPaths(projectsRoot, knownSessionId)) indexedPaths.add(path);
			} catch {
				directoriesUnavailable = true;
			}
		} else
			for (const cwd of worktree?.aliases ?? [])
				roots.push(join(projectsRoot, encodeClaudeProjectDirectoryName(cwd)));
	}
	for (const path of [...indexedPaths].sort())
		await classifyCandidate(path, agentId === "codex" && Boolean(knownSessionId));
	if (knownSessionId && candidates.length === 1 && !directoriesUnavailable && !unresolvedCandidatePaths.size)
		return result("verified", "通过已记录的原生 ID 找到转录，仅供阅读。");

	const scans =
		agentId === "claude" && knownSessionId
			? []
			: await Promise.all(
					[...new Set(roots)].map(async (root) => {
						const scan = await requestLegacyNativeHistorySourceScan(root, agentId, scanWindow);
						return { scan, reused: Boolean(scan?.entriesVisited) };
					}),
				);
	if (input.waitForScan) await Promise.all(scans.map(({ scan }) => scan?.completion));
	const scanInProgress = scans.some(({ scan }) => scan?.status === "scanning");
	let scanLimited = directoriesUnavailable;
	for (const { scan, reused } of scans) {
		if (!scan || scan.status === "limited") scanLimited = true;
		if (!scan) continue;
		scanCost = {
			...scanCost,
			directoryEntriesVisited: scanCost.directoryEntriesVisited + (reused ? 0 : scan.entriesVisited),
			transcriptFilesRead: scanCost.transcriptFilesRead + (reused ? 0 : scan.filesRead),
			decodedBytes: scanCost.decodedBytes + (reused ? 0 : scan.decodedBytes),
			cachedHeaders: scanCost.cachedHeaders + (reused ? scan.files.size : scan.cacheHits),
			reusedDirectoryScans: scanCost.reusedDirectoryScans + Number(reused),
		};
		for (const path of scan.uncheckedPaths) {
			if (
				knownSessionId
					? basename(path).includes(knownSessionId) || !/\.jsonl(?:\.zst)?$/u.test(path)
					: agentId === "claude" ||
						Boolean(scanWindow && codexNativeHistoryRolloutFallsInsideWindow(path, scanWindow))
			)
				unresolvedCandidatePaths.add(path);
		}
		for (const [path, { header }] of scan.files) {
			if (!header) continue;
			if (
				knownSessionId
					? header.nativeSessionId !== knownSessionId
					: !header.workingDirectoryPath || !worktree?.aliases.includes(header.workingDirectoryPath)
			)
				continue;
			await classifyCandidate(path);
		}
	}
	candidates.sort((left, right) =>
		String(left.identity.transcriptPath).localeCompare(String(right.identity.transcriptPath), "en"),
	);
	if (candidates.length > 1) return result("ambiguous", "多个原生转录符合归属证据。取得独立会话绑定后重验。");
	if (scanInProgress) return result("scanning", "正在后台核验原生转录目录，扫描结束后自动重查。");
	if (scanLimited || unresolvedCandidatePaths.size)
		return result(
			"search_limited",
			"所需检索范围存在未读原件、继承记录或预算缺口。来源可读、核验预算释放或绑定变化后重验。",
		);
	if (candidates.length === 1) return result("verified", "已核对任务工作树、原生记录时间和精确首提示词，仅供阅读。");
	return result(
		"no_matching_transcript",
		"已检查的来源未找到符合归属条件的原件。补齐来源目录、归档或原生绑定后重验。",
	);
}

export type LegacyNativeHistoryResolution = Awaited<ReturnType<typeof resolveLegacyNativeHistorySource>>;
