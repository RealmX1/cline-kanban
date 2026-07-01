import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GitCommitDiffCommitFile, GitCommitDiffSource } from "@/components/git-history/git-commit-diff-panel";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeGitCommit,
	RuntimeGitCommitChangedFileMetadata,
	RuntimeGitCommitChangedFileMetadataResponse,
	RuntimeGitCommitDiffResponse,
	RuntimeGitCommitFileDiffPatchResponse,
	RuntimeGitRef,
	RuntimeGitRefsResponse,
	RuntimeGitSyncSummary,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceChangesResponse,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export type GitHistoryViewMode = "working-copy" | "commit";

const INITIAL_COMMIT_PAGE_SIZE = 150;
const COMMIT_PAGE_SIZE = 150;
const EMPTY_REFS: RuntimeGitRef[] = [];
const EMPTY_LOG_REFS: string[] = [];

interface GitHistoryTaskScope {
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

interface UseGitHistoryDataOptions {
	workspaceId: string | null;
	taskScope?: GitHistoryTaskScope | null;
	gitSummary: RuntimeGitSyncSummary | null;
	stateVersion?: number;
	enabled?: boolean;
}

interface GitHistoryRefreshOptions {
	background?: boolean;
}

export interface UseGitHistoryDataResult {
	viewMode: GitHistoryViewMode;
	refs: RuntimeGitRef[];
	activeRef: RuntimeGitRef | null;
	refsErrorMessage: string | null;
	isRefsLoading: boolean;
	workingCopyFileCount: number;
	hasWorkingCopy: boolean;
	commits: RuntimeGitCommit[];
	totalCommitCount: number;
	selectedCommitHash: string | null;
	selectedCommit: RuntimeGitCommit | null;
	isLogLoading: boolean;
	isLoadingMoreCommits: boolean;
	logErrorMessage: string | null;
	diffSource: GitCommitDiffSource | null;
	isDiffLoading: boolean;
	diffErrorMessage: string | null;
	selectedDiffPath: string | null;
	selectWorkingCopy: () => void;
	selectRef: (ref: RuntimeGitRef) => void;
	selectCommit: (commit: RuntimeGitCommit) => void;
	selectDiffPath: (path: string | null) => void;
	loadCommitFileDiffPatch: (file: RuntimeGitCommitChangedFileMetadata) => Promise<void>;
	loadAllCommitFileDiffPatches: () => Promise<void>;
	loadMoreCommits: () => void;
	refresh: (options?: GitHistoryRefreshOptions) => void;
	isLoadingAllCommitFilePatches: boolean;
}

interface CommitFileDiffPatchState {
	patch: string | null;
	isLoading: boolean;
	errorMessage: string | null;
}

function buildCommitFileDiffPatchKey(file: { path: string; previousPath?: string }): string {
	return file.previousPath ? `${file.previousPath}\0${file.path}` : file.path;
}

export function useGitHistoryData({
	workspaceId,
	taskScope,
	gitSummary,
	stateVersion = 0,
	enabled = true,
}: UseGitHistoryDataOptions): UseGitHistoryDataResult {
	const [viewMode, setViewMode] = useState<GitHistoryViewMode>("commit");
	const [selectedRefName, setSelectedRefName] = useState<string | null>(null);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
	const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
	const [commitFileDiffPatchStateByKey, setCommitFileDiffPatchStateByKey] = useState<
		Record<string, CommitFileDiffPatchState>
	>({});
	const [isLoadingAllCommitFilePatches, setIsLoadingAllCommitFilePatches] = useState(false);
	const [allCommitFilePatchesErrorMessage, setAllCommitFilePatchesErrorMessage] = useState<string | null>(null);
	const [commits, setCommits] = useState<RuntimeGitCommit[]>([]);
	const [totalCommitCount, setTotalCommitCount] = useState(0);
	const [isLogLoading, setIsLogLoading] = useState(false);
	const [isLoadingMoreCommits, setIsLoadingMoreCommits] = useState(false);
	const [logErrorMessage, setLogErrorMessage] = useState<string | null>(null);
	const [resolvedLogKey, setResolvedLogKey] = useState<string | null>(null);
	// Commit log requests can overlap when users switch refs quickly or trigger refresh/load-more.
	// We cancel older in-flight requests so stale responses cannot overwrite state from newer requests.
	const logAbortControllerRef = useRef<AbortController | null>(null);

	const abortInFlightLogRequest = useCallback(() => {
		logAbortControllerRef.current?.abort();
		logAbortControllerRef.current = null;
	}, []);

	const isAbortError = useCallback((error: unknown): boolean => {
		if (!(error instanceof Error)) {
			return false;
		}
		const name = error.name.toLowerCase();
		const message = error.message.toLowerCase();
		return name === "aborterror" || message.includes("aborted") || message.includes("aborterror");
	}, []);

	const refsQueryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		const payload = await trpc.workspace.getGitRefs.query(taskScope ?? null);
		if (!payload.ok) {
			throw new Error(payload.error ?? "Could not load git refs.");
		}
		return payload;
	}, [taskScope, workspaceId]);

	const refsQuery = useTrpcQuery<RuntimeGitRefsResponse>({
		enabled: enabled && workspaceId !== null,
		queryFn: refsQueryFn,
		retainDataOnError: true,
	});

	const scopeKey = `${workspaceId ?? "__none__"}:${taskScope?.taskId ?? "__home__"}:${taskScope?.baseRef ?? "__home__"}:${taskScope?.worktreeMode ?? "__home__"}`;
	const prevScopeKeyRef = useRef(scopeKey);
	const isScopeTransitioning = prevScopeKeyRef.current !== scopeKey;

	const prevBranchRef = useRef(gitSummary?.currentBranch ?? null);
	useEffect(() => {
		const current = gitSummary?.currentBranch ?? null;
		if (current !== prevBranchRef.current) {
			prevBranchRef.current = current;
			setSelectedRefName(null);
			setSelectedCommitHash(null);
			if (enabled) {
				void refsQuery.refetch();
			}
		}
	}, [enabled, gitSummary?.currentBranch, refsQuery.refetch]);

	const refs = isScopeTransitioning ? EMPTY_REFS : (refsQuery.data?.refs ?? EMPTY_REFS);
	const isRefsLoadingVisible =
		isScopeTransitioning ||
		(enabled && workspaceId !== null && refsQuery.data === null && !refsQuery.isError) ||
		(refsQuery.isLoading && refs.length === 0);
	const refsErrorMessage =
		!isScopeTransitioning && refsQuery.isError && refs.length === 0
			? (refsQuery.error?.message ?? "Could not load git refs.")
			: null;
	const headRef = refs.find((ref) => ref.isHead);

	const activeRef = useMemo(() => {
		if (selectedRefName) {
			return refs.find((ref) => ref.name === selectedRefName) ?? headRef ?? null;
		}
		return headRef ?? null;
	}, [headRef, refs, selectedRefName]);

	const logRefs = useMemo(() => {
		if (!activeRef) {
			return EMPTY_LOG_REFS;
		}
		if (activeRef.type === "detached") {
			return [activeRef.hash];
		}
		if (activeRef.type === "branch") {
			const resolvedRefs = [activeRef.name];
			if (activeRef.upstreamName && refs.some((ref) => ref.name === activeRef.upstreamName)) {
				resolvedRefs.push(activeRef.upstreamName);
			}
			return resolvedRefs;
		}
		return [activeRef.name];
	}, [activeRef, refs]);
	const logKey = `${scopeKey}:${logRefs.length > 0 ? logRefs.join("|") : "__no_ref__"}`;
	const commitDiffScopeKey = `${scopeKey}:${selectedCommitHash ?? "__no_commit__"}`;
	const commitDiffScopeKeyRef = useRef(commitDiffScopeKey);

	useEffect(() => {
		commitDiffScopeKeyRef.current = commitDiffScopeKey;
		setCommitFileDiffPatchStateByKey({});
		setIsLoadingAllCommitFilePatches(false);
		setAllCommitFilePatchesErrorMessage(null);
	}, [commitDiffScopeKey]);

	const loadCommits = useCallback(
		async (options: { skip: number; maxCount: number; append: boolean; silent?: boolean }) => {
			if (!enabled || !workspaceId || logRefs.length === 0) {
				abortInFlightLogRequest();
				setCommits([]);
				setTotalCommitCount(0);
				setLogErrorMessage(null);
				setIsLogLoading(false);
				setIsLoadingMoreCommits(false);
				return;
			}

			abortInFlightLogRequest();
			const abortController = new AbortController();
			logAbortControllerRef.current = abortController;
			if (options.append) {
				setIsLoadingMoreCommits(true);
			} else {
				if (!options.silent) {
					setIsLogLoading(true);
					setLogErrorMessage(null);
				} else {
					setIsLogLoading(false);
				}
			}

			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				const payload = await trpc.workspace.getGitLog.query(
					{
						ref: logRefs[0] ?? null,
						refs: logRefs,
						maxCount: options.maxCount,
						skip: options.skip,
						taskScope: taskScope ?? null,
					},
					{
						signal: abortController.signal,
					},
				);
				if (abortController.signal.aborted || logAbortControllerRef.current !== abortController) {
					return;
				}
				if (!payload.ok) {
					if (options.silent) {
						setResolvedLogKey(logKey);
						return;
					}
					if (!options.append) {
						setCommits([]);
						setTotalCommitCount(0);
					}
					setLogErrorMessage(payload.error ?? "Could not load commits.");
					setResolvedLogKey(logKey);
					return;
				}

				setLogErrorMessage(null);
				setTotalCommitCount(payload.totalCount);
				setResolvedLogKey(logKey);
				setCommits((current) => {
					if (!options.append) {
						return payload.commits;
					}
					const existingHashes = new Set(current.map((commit) => commit.hash));
					const nextCommits = payload.commits.filter((commit) => !existingHashes.has(commit.hash));
					return [...current, ...nextCommits];
				});
			} catch (error) {
				if (abortController.signal.aborted || logAbortControllerRef.current !== abortController) {
					return;
				}
				if (isAbortError(error)) {
					return;
				}
				if (options.silent) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (!options.append) {
					setCommits([]);
					setTotalCommitCount(0);
				}
				setLogErrorMessage(message || "Could not load commits.");
				setResolvedLogKey(logKey);
			} finally {
				if (logAbortControllerRef.current === abortController) {
					logAbortControllerRef.current = null;
					if (options.append) {
						setIsLoadingMoreCommits(false);
					} else {
						setIsLogLoading(false);
					}
				}
			}
		},
		[abortInFlightLogRequest, enabled, isAbortError, logKey, logRefs, taskScope, workspaceId],
	);

	useEffect(() => {
		abortInFlightLogRequest();
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		if (!enabled || !workspaceId || logRefs.length === 0) {
			return;
		}
		void loadCommits({
			skip: 0,
			maxCount: INITIAL_COMMIT_PAGE_SIZE,
			append: false,
		});
	}, [abortInFlightLogRequest, enabled, loadCommits, logRefs, workspaceId]);

	useEffect(() => {
		return () => {
			abortInFlightLogRequest();
		};
	}, [abortInFlightLogRequest]);

	const loadMoreCommits = useCallback(() => {
		if (!enabled || !workspaceId || logRefs.length === 0 || isLogLoading || isLoadingMoreCommits) {
			return;
		}
		if (commits.length >= totalCommitCount) {
			return;
		}
		void loadCommits({
			skip: commits.length,
			maxCount: COMMIT_PAGE_SIZE,
			append: true,
		});
	}, [
		commits.length,
		enabled,
		isLoadingMoreCommits,
		isLogLoading,
		loadCommits,
		logRefs,
		totalCommitCount,
		workspaceId,
	]);

	const refreshCommits = useCallback(
		(options?: { silent?: boolean }) => {
			if (!enabled || !workspaceId || logRefs.length === 0) {
				return;
			}
			void loadCommits({
				skip: 0,
				maxCount: Math.max(commits.length, INITIAL_COMMIT_PAGE_SIZE),
				append: false,
				silent: options?.silent ?? false,
			});
		},
		[commits.length, enabled, loadCommits, logRefs, workspaceId],
	);

	const resolvedLogErrorMessage = refsErrorMessage ?? logErrorMessage;

	useEffect(() => {
		if (viewMode === "working-copy") {
			return;
		}
		if (selectedCommitHash && commits.some((commit) => commit.hash === selectedCommitHash)) {
			return;
		}
		const preferredCommit = activeRef
			? (commits.find((commit) => commit.hash === activeRef.hash) ?? commits[0])
			: commits[0];
		setSelectedCommitHash(preferredCommit?.hash ?? null);
		setSelectedDiffPath(null);
	}, [activeRef, commits, selectedCommitHash, viewMode]);

	const commitChangedFileMetadataQueryFn = useCallback(async () => {
		if (!workspaceId || !selectedCommitHash) {
			throw new Error("Missing scope.");
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		return await trpc.workspace.getCommitChangedFileMetadata.query({
			commitHash: selectedCommitHash,
			taskScope: taskScope ?? null,
		});
	}, [selectedCommitHash, taskScope, workspaceId]);

	const commitChangedFileMetadataQuery = useTrpcQuery<RuntimeGitCommitChangedFileMetadataResponse>({
		enabled:
			!isScopeTransitioning &&
			enabled &&
			workspaceId !== null &&
			selectedCommitHash !== null &&
			viewMode === "commit",
		queryFn: commitChangedFileMetadataQueryFn,
	});

	const loadCommitFileDiffPatch = useCallback(
		async (file: RuntimeGitCommitChangedFileMetadata) => {
			if (!enabled || !workspaceId || !selectedCommitHash || viewMode !== "commit") {
				return;
			}
			const requestCommitDiffScopeKey = commitDiffScopeKey;
			const patchKey = buildCommitFileDiffPatchKey(file);
			const existingPatchState = commitFileDiffPatchStateByKey[patchKey];
			if (existingPatchState?.isLoading || existingPatchState?.patch != null) {
				return;
			}
			setCommitFileDiffPatchStateByKey((current) => {
				const currentPatchState = current[patchKey];
				if (currentPatchState?.isLoading || currentPatchState?.patch != null) {
					return current;
				}
				return {
					...current,
					[patchKey]: {
						patch: currentPatchState?.patch ?? null,
						isLoading: true,
						errorMessage: null,
					},
				};
			});

			try {
				const trpc = getRuntimeTrpcClient(workspaceId);
				const payload = (await trpc.workspace.getCommitFileDiffPatch.query({
					commitHash: selectedCommitHash,
					path: file.path,
					previousPath: file.previousPath,
					taskScope: taskScope ?? null,
				})) as RuntimeGitCommitFileDiffPatchResponse;
				if (commitDiffScopeKeyRef.current !== requestCommitDiffScopeKey) {
					return;
				}
				setCommitFileDiffPatchStateByKey((current) => ({
					...current,
					[patchKey]: {
						patch: payload.ok ? payload.patch : null,
						isLoading: false,
						errorMessage: payload.ok ? null : (payload.error ?? "Could not load file diff."),
					},
				}));
			} catch (error) {
				if (commitDiffScopeKeyRef.current !== requestCommitDiffScopeKey) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				setCommitFileDiffPatchStateByKey((current) => ({
					...current,
					[patchKey]: {
						patch: null,
						isLoading: false,
						errorMessage: message || "Could not load file diff.",
					},
				}));
			}
		},
		[
			commitDiffScopeKey,
			commitFileDiffPatchStateByKey,
			enabled,
			selectedCommitHash,
			taskScope,
			viewMode,
			workspaceId,
		],
	);

	const loadAllCommitFileDiffPatches = useCallback(async () => {
		if (!enabled || !workspaceId || !selectedCommitHash || viewMode !== "commit" || isLoadingAllCommitFilePatches) {
			return;
		}
		const metadataFiles = commitChangedFileMetadataQuery.data?.files ?? [];
		const requestCommitDiffScopeKey = commitDiffScopeKey;
		setIsLoadingAllCommitFilePatches(true);
		setAllCommitFilePatchesErrorMessage(null);
		setCommitFileDiffPatchStateByKey((current) => {
			const next = { ...current };
			for (const file of metadataFiles) {
				const patchKey = buildCommitFileDiffPatchKey(file);
				const existing = next[patchKey];
				if (existing?.patch !== null && existing?.patch !== undefined) {
					continue;
				}
				next[patchKey] = {
					patch: null,
					isLoading: true,
					errorMessage: null,
				};
			}
			return next;
		});

		try {
			const trpc = getRuntimeTrpcClient(workspaceId);
			const payload = (await trpc.workspace.getCommitDiff.query({
				commitHash: selectedCommitHash,
				taskScope: taskScope ?? null,
			})) as RuntimeGitCommitDiffResponse;
			if (commitDiffScopeKeyRef.current !== requestCommitDiffScopeKey) {
				return;
			}
			if (!payload.ok) {
				const errorMessage = payload.error ?? "Could not load all file diffs.";
				setAllCommitFilePatchesErrorMessage(errorMessage);
				setCommitFileDiffPatchStateByKey((current) => {
					const next = { ...current };
					for (const file of metadataFiles) {
						const patchKey = buildCommitFileDiffPatchKey(file);
						if (next[patchKey]?.isLoading) {
							next[patchKey] = { patch: null, isLoading: false, errorMessage };
						}
					}
					return next;
				});
				return;
			}
			setCommitFileDiffPatchStateByKey((current) => {
				const next = { ...current };
				const payloadPatchByKey = new Map(
					payload.files.map((file) => [
						buildCommitFileDiffPatchKey(file),
						{
							patch: file.patch,
							isLoading: false,
							errorMessage: null,
						},
					]),
				);
				for (const file of metadataFiles) {
					const patchKey = buildCommitFileDiffPatchKey(file);
					next[patchKey] = payloadPatchByKey.get(patchKey) ?? {
						patch: next[patchKey]?.patch ?? null,
						isLoading: false,
						errorMessage: null,
					};
				}
				for (const file of payload.files) {
					next[buildCommitFileDiffPatchKey(file)] = {
						patch: file.patch,
						isLoading: false,
						errorMessage: null,
					};
				}
				return next;
			});
		} catch (error) {
			if (commitDiffScopeKeyRef.current !== requestCommitDiffScopeKey) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const errorMessage = message || "Could not load all file diffs.";
			setAllCommitFilePatchesErrorMessage(errorMessage);
			setCommitFileDiffPatchStateByKey((current) => {
				const next = { ...current };
				for (const file of metadataFiles) {
					const patchKey = buildCommitFileDiffPatchKey(file);
					if (next[patchKey]?.isLoading) {
						next[patchKey] = { patch: null, isLoading: false, errorMessage };
					}
				}
				return next;
			});
		} finally {
			if (commitDiffScopeKeyRef.current === requestCommitDiffScopeKey) {
				setIsLoadingAllCommitFilePatches(false);
			}
		}
	}, [
		commitChangedFileMetadataQuery.data?.files,
		commitDiffScopeKey,
		enabled,
		isLoadingAllCommitFilePatches,
		selectedCommitHash,
		taskScope,
		viewMode,
		workspaceId,
	]);

	const summaryWorkingCopyFileCount = gitSummary?.changedFiles ?? null;

	const workingCopyQueryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		const trpc = getRuntimeTrpcClient(workspaceId);
		if (taskScope) {
			return await trpc.workspace.getChanges.query(taskScope);
		}
		return await trpc.workspace.getWorkspaceChanges.query();
	}, [taskScope, workspaceId]);
	const shouldLoadWorkingCopyChanges =
		!isScopeTransitioning &&
		enabled &&
		workspaceId !== null &&
		(taskScope != null || (summaryWorkingCopyFileCount ?? 0) > 0);

	const workingCopyQuery = useTrpcQuery<RuntimeWorkspaceChangesResponse>({
		enabled: shouldLoadWorkingCopyChanges,
		queryFn: workingCopyQueryFn,
		retainDataOnError: true,
	});

	useEffect(() => {
		if (enabled) {
			return;
		}
		abortInFlightLogRequest();
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		refsQuery.setData(null);
		commitChangedFileMetadataQuery.setData(null);
		setCommitFileDiffPatchStateByKey({});
		setIsLoadingAllCommitFilePatches(false);
		setAllCommitFilePatchesErrorMessage(null);
		workingCopyQuery.setData(null);
	}, [
		abortInFlightLogRequest,
		commitChangedFileMetadataQuery.setData,
		enabled,
		refsQuery.setData,
		workingCopyQuery.setData,
	]);

	useEffect(() => {
		if (!isScopeTransitioning) {
			return;
		}
		prevScopeKeyRef.current = scopeKey;
		abortInFlightLogRequest();
		setViewMode("commit");
		setSelectedRefName(null);
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
		setCommits([]);
		setTotalCommitCount(0);
		setIsLogLoading(false);
		setIsLoadingMoreCommits(false);
		setLogErrorMessage(null);
		setResolvedLogKey(null);
		refsQuery.setData(null);
		commitChangedFileMetadataQuery.setData(null);
		setCommitFileDiffPatchStateByKey({});
		setIsLoadingAllCommitFilePatches(false);
		setAllCommitFilePatchesErrorMessage(null);
		workingCopyQuery.setData(null);
	}, [
		abortInFlightLogRequest,
		commitChangedFileMetadataQuery.setData,
		isScopeTransitioning,
		refsQuery.setData,
		scopeKey,
		workingCopyQuery.setData,
	]);

	const workingCopyFileCount = summaryWorkingCopyFileCount ?? workingCopyQuery.data?.files.length ?? 0;
	const hasWorkingCopy = workingCopyFileCount > 0;
	const isLogLoadingVisible =
		isScopeTransitioning ||
		isRefsLoadingVisible ||
		isLogLoading ||
		(enabled && workspaceId !== null && logRefs.length > 0 && resolvedLogKey !== logKey);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		if (!enabled || !workspaceId || isScopeTransitioning) {
			return;
		}
		void refsQuery.refetch();
		refreshCommits({ silent: true });
		if (viewMode === "commit" && selectedCommitHash && commitChangedFileMetadataQuery.data) {
			void commitChangedFileMetadataQuery.refetch();
		}
		if (shouldLoadWorkingCopyChanges || workingCopyQuery.data) {
			void workingCopyQuery.refetch();
		}
	}, [
		commitChangedFileMetadataQuery.data,
		commitChangedFileMetadataQuery.refetch,
		enabled,
		refsQuery.refetch,
		refreshCommits,
		selectedCommitHash,
		shouldLoadWorkingCopyChanges,
		stateVersion,
		isScopeTransitioning,
		viewMode,
		workingCopyQuery.data,
		workingCopyQuery.refetch,
		workspaceId,
	]);

	const selectWorkingCopy = useCallback(() => {
		setViewMode("working-copy");
		setSelectedRefName(null);
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
	}, []);

	const selectRef = useCallback((ref: RuntimeGitRef) => {
		setSelectedRefName(ref.name);
		setViewMode("commit");
		setSelectedCommitHash(null);
		setSelectedDiffPath(null);
	}, []);

	const selectCommit = useCallback((commit: RuntimeGitCommit) => {
		setViewMode("commit");
		setSelectedCommitHash(commit.hash);
		setSelectedDiffPath(null);
	}, []);

	const diffSource = useMemo((): GitCommitDiffSource | null => {
		if (viewMode === "working-copy") {
			const files = workingCopyQuery.data?.files;
			if (!files) {
				return null;
			}
			return { type: "working-copy", files };
		}
		const commitFiles = commitChangedFileMetadataQuery.data?.files;
		if (!commitFiles) {
			return null;
		}
		return {
			type: "commit",
			files: commitFiles.map((file): GitCommitDiffCommitFile => {
				const patchState = commitFileDiffPatchStateByKey[buildCommitFileDiffPatchKey(file)];
				return {
					...file,
					patch: patchState?.patch ?? null,
					isPatchLoading: patchState?.isLoading ?? false,
					patchErrorMessage: patchState?.errorMessage ?? null,
				};
			}),
		};
	}, [
		commitChangedFileMetadataQuery.data?.files,
		commitFileDiffPatchStateByKey,
		viewMode,
		workingCopyQuery.data?.files,
	]);

	const selectedCommit = commits.find((commit) => commit.hash === selectedCommitHash) ?? null;
	const isCommitChangedFileMetadataLoading =
		viewMode === "commit" &&
		selectedCommitHash !== null &&
		commitChangedFileMetadataQuery.isLoading &&
		commitChangedFileMetadataQuery.data === null;
	const isDiffLoading =
		viewMode === "commit"
			? isLogLoading || isCommitChangedFileMetadataLoading
			: workingCopyQuery.isLoading && !workingCopyQuery.data;
	const diffErrorMessage =
		viewMode === "commit"
			? (resolvedLogErrorMessage ??
				(commitChangedFileMetadataQuery.isError
					? (commitChangedFileMetadataQuery.error?.message ?? "Could not load changed files.")
					: commitChangedFileMetadataQuery.data && !commitChangedFileMetadataQuery.data.ok
						? (commitChangedFileMetadataQuery.data.error ?? "Could not load changed files.")
						: allCommitFilePatchesErrorMessage))
			: workingCopyQuery.isError && !workingCopyQuery.data
				? (workingCopyQuery.error?.message ?? "Could not load working copy changes.")
				: null;

	useEffect(() => {
		if (!hasWorkingCopy && viewMode === "working-copy") {
			setViewMode("commit");
			setSelectedDiffPath(null);
		}
	}, [hasWorkingCopy, viewMode]);

	const refresh = useCallback(
		(options?: GitHistoryRefreshOptions) => {
			if (!enabled || isScopeTransitioning) {
				return;
			}
			const isBackgroundRefresh = options?.background === true;
			if (isBackgroundRefresh) {
				if (!refsQuery.isLoading) {
					void refsQuery.refetch();
				}
				if (!isLogLoading && !isLoadingMoreCommits) {
					refreshCommits({
						silent: true,
					});
				}
				if (viewMode === "commit" && selectedCommitHash && !commitChangedFileMetadataQuery.isLoading) {
					void commitChangedFileMetadataQuery.refetch();
				}
				if (shouldLoadWorkingCopyChanges && !workingCopyQuery.isLoading) {
					void workingCopyQuery.refetch();
				}
				return;
			}

			void refsQuery.refetch();
			refreshCommits({
				silent: false,
			});
			if (viewMode === "commit" && selectedCommitHash) {
				void commitChangedFileMetadataQuery.refetch();
			}
			if (shouldLoadWorkingCopyChanges) {
				void workingCopyQuery.refetch();
			}
		},
		[
			enabled,
			commitChangedFileMetadataQuery,
			isScopeTransitioning,
			isLoadingMoreCommits,
			isLogLoading,
			refsQuery,
			refsQueryFn,
			refreshCommits,
			selectedCommitHash,
			shouldLoadWorkingCopyChanges,
			viewMode,
			workingCopyQuery,
			workingCopyQueryFn,
		],
	);

	const visibleCommits = isScopeTransitioning ? [] : commits;
	const visibleSelectedCommitHash = isScopeTransitioning ? null : selectedCommitHash;
	const visibleSelectedCommit = isScopeTransitioning ? null : selectedCommit;
	const visibleWorkingCopyFileCount = isScopeTransitioning ? 0 : workingCopyFileCount;
	const visibleHasWorkingCopy = isScopeTransitioning ? false : hasWorkingCopy;
	const visibleDiffSource = isScopeTransitioning ? null : diffSource;
	const visibleSelectedDiffPath = isScopeTransitioning ? null : selectedDiffPath;
	const visibleRefsErrorMessage = isScopeTransitioning ? null : refsErrorMessage;
	const visibleLogErrorMessage = isScopeTransitioning ? null : resolvedLogErrorMessage;
	const visibleDiffErrorMessage = isScopeTransitioning ? null : diffErrorMessage;
	const visibleIsLoadingAllCommitFilePatches = isScopeTransitioning ? false : isLoadingAllCommitFilePatches;

	return {
		viewMode,
		refs,
		activeRef,
		refsErrorMessage: visibleRefsErrorMessage,
		isRefsLoading: isRefsLoadingVisible,
		workingCopyFileCount: visibleWorkingCopyFileCount,
		hasWorkingCopy: visibleHasWorkingCopy,
		commits: visibleCommits,
		totalCommitCount: isScopeTransitioning ? 0 : totalCommitCount,
		selectedCommitHash: visibleSelectedCommitHash,
		selectedCommit: visibleSelectedCommit,
		isLogLoading: isLogLoadingVisible,
		isLoadingMoreCommits,
		logErrorMessage: visibleLogErrorMessage,
		diffSource: visibleDiffSource,
		isDiffLoading: isScopeTransitioning || isRefsLoadingVisible || isLogLoadingVisible || isDiffLoading,
		diffErrorMessage: visibleDiffErrorMessage,
		selectedDiffPath: visibleSelectedDiffPath,
		selectWorkingCopy,
		selectRef,
		selectCommit,
		selectDiffPath: setSelectedDiffPath,
		loadCommitFileDiffPatch,
		loadAllCommitFileDiffPatches,
		loadMoreCommits,
		refresh,
		isLoadingAllCommitFilePatches: visibleIsLoadingAllCommitFilePatches,
	};
}
