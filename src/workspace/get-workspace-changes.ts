import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";
import { gitFileReadConcurrencyLimiter } from "./git-concurrency";
import { getGitStdout as getGitStdoutWithoutTimeout } from "./git-utils";

const WORKSPACE_CHANGES_GIT_TIMEOUT_MS = 30_000;

async function getGitStdout(args: string[], cwd: string): Promise<string> {
	return await getGitStdoutWithoutTimeout(args, cwd, { timeoutMs: WORKSPACE_CHANGES_GIT_TIMEOUT_MS });
}

// `git diff --numstat -z` 是 NUL 分隔的二进制格式，不能走默认的 trim（trim 虽不会动 NUL 字节，但为
// 精确解析该格式，保留原始 stdout 更稳妥）。
async function getGitStdoutWithoutTrimming(args: string[], cwd: string): Promise<string> {
	return await getGitStdoutWithoutTimeout(args, cwd, {
		timeoutMs: WORKSPACE_CHANGES_GIT_TIMEOUT_MS,
		trimStdout: false,
	});
}

const WORKSPACE_CHANGES_CACHE_MAX_ENTRIES = 128;

// ponytail: 单文件 diff 内联渲染上限（old+new 合计字符数）。超过则不回传全文——payload 传输、
// JSON.parse、以及前端 Prism 高亮 + DOM 行渲染都随文件大小线性膨胀，一个 lockfile / 生成文件即可
// 拖垮整个 app。仅保留 additions/deletions 供表头显示。阈值取"内联审查已无意义"的量级（~万行级）;
// 需要查看超大文件时应走按需加载（未实现）。上调：改此常量即可。
const MAX_INLINE_DIFF_TEXT_LENGTH = 1024 * 1024;

function applyInlineDiffContentSizeLimit(change: RuntimeWorkspaceFileChange): RuntimeWorkspaceFileChange {
	const combinedLength = (change.oldText?.length ?? 0) + (change.newText?.length ?? 0);
	if (combinedLength <= MAX_INLINE_DIFF_TEXT_LENGTH) {
		return change;
	}
	return {
		...change,
		oldText: null,
		newText: null,
		contentOmittedForSize: true,
	};
}

// 三种 diff 变体各自独立缓存：working_copy(HEAD↔工作树)、from_ref(某 commit↔工作树)、
// between_refs(commit↔commit)。cacheKey 含 variant + refs，故它们互不覆盖。
type WorkspaceChangesVariant = "working_copy" | "from_ref" | "between_refs";

interface WorkspaceChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkspaceChangesResponse;
	lastAccessedAt: number;
}

const workspaceChangesCacheByCacheKey = new Map<string, WorkspaceChangesCacheEntry>();

function buildWorkspaceChangesCacheKey(input: {
	repoRoot: string;
	variant: WorkspaceChangesVariant;
	fromRef?: string;
	toRef?: string;
}): string {
	return [input.repoRoot, input.variant, input.fromRef ?? "", input.toRef ?? ""].join("::");
}

function readCachedWorkspaceChanges(cacheKey: string, stateKey: string): RuntimeWorkspaceChangesResponse | null {
	const existing = workspaceChangesCacheByCacheKey.get(cacheKey);
	if (existing && existing.stateKey === stateKey) {
		existing.lastAccessedAt = Date.now();
		return existing.response;
	}
	return null;
}

function storeCachedWorkspaceChanges(
	cacheKey: string,
	stateKey: string,
	response: RuntimeWorkspaceChangesResponse,
): void {
	workspaceChangesCacheByCacheKey.set(cacheKey, {
		stateKey,
		response,
		lastAccessedAt: Date.now(),
	});
	pruneWorkspaceChangesCache();
}

interface NameStatusEntry {
	path: string;
	status: RuntimeWorkspaceFileStatus;
	previousPath?: string;
}

interface ChangesBetweenRefsInput {
	cwd: string;
	fromRef: string;
	toRef: string;
}

interface ChangesFromRefInput {
	cwd: string;
	fromRef: string;
}

interface DiffStat {
	additions: number;
	deletions: number;
}

interface FileFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

function mapNameStatus(code: string): RuntimeWorkspaceFileStatus {
	const kind = code.charAt(0);
	if (kind === "M") return "modified";
	if (kind === "A") return "added";
	if (kind === "D") return "deleted";
	if (kind === "R") return "renamed";
	if (kind === "C") return "copied";
	return "unknown";
}

function toLineCount(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseTrackedChanges(output: string): NameStatusEntry[] {
	const entries: NameStatusEntry[] = [];
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		const statusCode = parts[0];
		const status = mapNameStatus(statusCode);

		if ((status === "renamed" || status === "copied") && parts.length >= 3) {
			const previousPath = parts[1];
			const path = parts[2];
			if (path) {
				entries.push({
					path,
					previousPath: previousPath || undefined,
					status,
				});
			}
			continue;
		}

		const path = parts[1];
		if (path) {
			entries.push({
				path,
				status,
			});
		}
	}

	return entries;
}

function parseNumstatCount(raw: string): number {
	// 二进制文件的 numstat 计数为 `-`；Number.parseInt("-") → NaN → 归零，与旧的 per-file 解析一致。
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : 0;
}

// 把一次 `git diff --numstat -z <range>` 的整段输出解析为 <postimage-path, DiffStat> 映射，
// key 一律用 postimage（当前/新）路径，正好对应 NameStatusEntry.path 的查询方式。
// 记录格式（NUL 分隔）：
//   普通       `adds\tdels\tpath\0`
//   rename/copy `adds\tdels\t\0oldpath\0newpath\0`（counts 后 inline path 为空，紧跟两条 NUL 分隔路径）
//   二进制     计数字段为 `-`（→ 0）
// 这是替代「每文件各跑一次 git diff --numstat」的批量化路径：N 次 spawn 收敛为 1 次。
function parseNumstatByPostimagePath(output: string): Map<string, DiffStat> {
	const statsByPath = new Map<string, DiffStat>();
	const tokens = output.split("\0");
	let index = 0;
	while (index < tokens.length) {
		const record = tokens[index];
		if (record === undefined || record === "") {
			index += 1;
			continue;
		}
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab === -1 || secondTab === -1) {
			index += 1;
			continue;
		}
		const additions = parseNumstatCount(record.slice(0, firstTab));
		const deletions = parseNumstatCount(record.slice(firstTab + 1, secondTab));
		const inlinePath = record.slice(secondTab + 1);
		if (inlinePath !== "") {
			statsByPath.set(inlinePath, { additions, deletions });
			index += 1;
			continue;
		}
		// rename/copy：接下来两个 token 依次是 preimage、postimage 路径，key 取 postimage。
		const postimagePath = tokens[index + 2];
		if (postimagePath !== undefined && postimagePath !== "") {
			statsByPath.set(postimagePath, { additions, deletions });
		}
		index += 3;
	}
	return statsByPath;
}

// 批量读取整个 diff range 的 numstat。`diffRangeArgs` 必须与对应 name-status 调用的 refspec/renames
// 标志保持一致，以保证 rename 检测方式相同、path 集合对齐（否则 rename 在两处的配对不一致）。
async function readDiffStatsByPostimagePath(repoRoot: string, diffRangeArgs: string[]): Promise<Map<string, DiffStat>> {
	try {
		const output = await getGitStdoutWithoutTrimming(["diff", "--numstat", "-z", ...diffRangeArgs], repoRoot);
		return parseNumstatByPostimagePath(output);
	} catch {
		return new Map();
	}
}

async function buildFileFingerprints(repoRoot: string, paths: string[]): Promise<FileFingerprint[]> {
	if (paths.length === 0) {
		return [];
	}
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	const entries = await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			const absolutePath = join(repoRoot, path);
			try {
				const fileStat = await stat(absolutePath);
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies FileFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies FileFingerprint;
			}
		}),
	);
	return entries;
}

function buildWorkspaceChangesStateKey(input: {
	repoRoot: string;
	headCommit: string | null;
	trackedChangesOutput: string;
	untrackedOutput: string;
	fingerprints: FileFingerprint[];
}): string {
	const fingerprintsToken = input.fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
	return [
		input.repoRoot,
		input.headCommit ?? "no-head",
		input.trackedChangesOutput,
		input.untrackedOutput,
		fingerprintsToken,
	].join("\n--\n");
}

function pruneWorkspaceChangesCache(): void {
	if (workspaceChangesCacheByCacheKey.size <= WORKSPACE_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(workspaceChangesCacheByCacheKey.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - WORKSPACE_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		workspaceChangesCacheByCacheKey.delete(candidate[0]);
	}
}

async function readHeadFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `HEAD:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readFileAtRef(repoRoot: string, ref: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `${ref}:${path}`], repoRoot);
	} catch {
		return null;
	}
}

// 把 ref 解析为不可变 commit SHA，纳入 between_refs / from_ref 的缓存 stateKey。
// 若 ref 是可移动分支名，它移动到另一个提交后——即便两端 diff 的文件集合与 name-status 状态字母不变
// （仅文件内容变化）——解析出的 SHA 也会改变 → stateKey 改变 → 缓存自然失效，避免返回陈旧的
// old/new 内容与 additions/deletions 统计。解析失败（如 ref 不存在）时安全降级为原 ref 字符串
// （不比未解析更差）。`^{commit}` 会剥掉注解标签，稳妥地落到提交对象上。
async function resolveRefToCommitToken(repoRoot: string, ref: string): Promise<string> {
	try {
		const resolved = (await getGitStdout(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot)).trim();
		return resolved || ref;
	} catch {
		return ref;
	}
}

async function readWorkingTreeFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return null;
	}
}

function fallbackStats(oldText: string | null, newText: string | null): DiffStat {
	if (oldText == null && newText == null) {
		return { additions: 0, deletions: 0 };
	}
	if (oldText == null) {
		return { additions: toLineCount(newText ?? ""), deletions: 0 };
	}
	if (newText == null) {
		return { additions: 0, deletions: toLineCount(oldText) };
	}

	const oldLines = toLineCount(oldText);
	const newLines = toLineCount(newText);
	return {
		additions: Math.max(newLines - oldLines, 0),
		deletions: Math.max(oldLines - newLines, 0),
	};
}

function resolveDiffStat(
	entry: NameStatusEntry,
	statsByPath: Map<string, DiffStat>,
	oldText: string | null,
	newText: string | null,
): DiffStat {
	if (entry.status === "untracked") {
		return { additions: toLineCount(newText ?? ""), deletions: 0 };
	}
	return statsByPath.get(entry.path) ?? fallbackStats(oldText, newText);
}

async function buildFileChange(
	repoRoot: string,
	entry: NameStatusEntry,
	statsByPath: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText =
		entry.status === "added" || entry.status === "untracked" ? null : await readHeadFile(repoRoot, basePath);
	const newText = entry.status === "deleted" ? null : await readWorkingTreeFile(repoRoot, entry.path);
	const stats = resolveDiffStat(entry, statsByPath, oldText, newText);

	return applyInlineDiffContentSizeLimit({
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	});
}

async function buildFileChangeBetweenRefs(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
	toRef: string,
	statsByPath: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText = entry.status === "added" ? null : await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readFileAtRef(repoRoot, toRef, entry.path);
	const stats = statsByPath.get(entry.path) ?? fallbackStats(oldText, newText);

	return applyInlineDiffContentSizeLimit({
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	});
}

async function buildFileChangeFromRef(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
	statsByPath: Map<string, DiffStat>,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText =
		entry.status === "added" || entry.status === "untracked"
			? null
			: await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readWorkingTreeFile(repoRoot, entry.path);
	const stats = resolveDiffStat(entry, statsByPath, oldText, newText);

	return applyInlineDiffContentSizeLimit({
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	});
}

// 把已知的一组变更条目落地为完整的 file changes：批量取一次 numstat，再经共享并发限流器读取每个文件的
// old/new 内容。限流器是跨请求共享的模块级单例，保证任意负载下并发 git/fs 读取被钳制成常数。
async function materializeFileChanges<Entry extends NameStatusEntry>(
	entries: readonly Entry[],
	diffRangeArgs: string[],
	repoRoot: string,
	buildOne: (entry: Entry, statsByPath: Map<string, DiffStat>) => Promise<RuntimeWorkspaceFileChange>,
): Promise<RuntimeWorkspaceFileChange[]> {
	const statsByPath = await readDiffStatsByPostimagePath(repoRoot, diffRangeArgs);
	const files = await Promise.all(
		entries.map((entry) => gitFileReadConcurrencyLimiter(() => buildOne(entry, statsByPath))),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
}

export async function createEmptyWorkspaceChangesResponse(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}
	return {
		repoRoot,
		generatedAt: Date.now(),
		files: [],
	};
}

export async function getWorkspaceChanges(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	const [trackedChangesOutput, untrackedOutput, headCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "HEAD", "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => ""),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const stateKey = buildWorkspaceChangesStateKey({
		repoRoot,
		headCommit: headCommitOutput.trim() || null,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const cacheKey = buildWorkspaceChangesCacheKey({ repoRoot, variant: "working_copy" });
	const cached = readCachedWorkspaceChanges(cacheKey, stateKey);
	if (cached) {
		return cached;
	}

	// numstat 的 refspec/renames 标志须与上面的 name-status 一致（此处均为 `HEAD --`、无 --find-renames）。
	const files = await materializeFileChanges(allChanges, ["HEAD", "--"], repoRoot, (entry, statsByPath) =>
		buildFileChange(repoRoot, entry, statsByPath),
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	storeCachedWorkspaceChanges(cacheKey, stateKey, response);
	return response;
}

export async function getWorkspaceChangesBetweenRefs(
	input: ChangesBetweenRefsInput,
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], input.cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	// 与 name-status 并行解析两端 ref 的 commit SHA（单次常量 spawn，不加 wall-clock 延迟）。
	const [trackedChangesOutput, resolvedFromRef, resolvedToRef] = await Promise.all([
		getGitStdout(["diff", "--name-status", "--find-renames", input.fromRef, input.toRef, "--"], repoRoot),
		resolveRefToCommitToken(repoRoot, input.fromRef),
		resolveRefToCommitToken(repoRoot, input.toRef),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	if (trackedChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	// 结果由「两端解析后的 commit SHA + name-status 输出」唯一确定。headCommit 必须用解析后的 SHA 对，
	// 而非原始 ref 字符串：可移动分支移动到新提交、但文件集合与 name-status 状态字母不变（仅内容变化）时，
	// 单看 name-status 无法察觉，唯有解析后的 SHA 改变才能触发 cache miss → 重算，避免返回陈旧内容。
	const stateKey = buildWorkspaceChangesStateKey({
		repoRoot,
		headCommit: `${resolvedFromRef}..${resolvedToRef}`,
		trackedChangesOutput,
		untrackedOutput: "",
		fingerprints: [],
	});
	const cacheKey = buildWorkspaceChangesCacheKey({
		repoRoot,
		variant: "between_refs",
		fromRef: input.fromRef,
		toRef: input.toRef,
	});
	const cached = readCachedWorkspaceChanges(cacheKey, stateKey);
	if (cached) {
		return cached;
	}

	const files = await materializeFileChanges(
		trackedChanges,
		["--find-renames", input.fromRef, input.toRef, "--"],
		repoRoot,
		(entry, statsByPath) => buildFileChangeBetweenRefs(repoRoot, entry, input.fromRef, input.toRef, statsByPath),
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	storeCachedWorkspaceChanges(cacheKey, stateKey, response);
	return response;
}

export async function getWorkspaceChangesFromRef(input: ChangesFromRefInput): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], input.cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}

	const [trackedChangesOutput, untrackedOutput, resolvedFromRef] = await Promise.all([
		getGitStdout(["diff", "--name-status", "--find-renames", input.fromRef, "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
		resolveRefToCommitToken(repoRoot, input.fromRef),
	]);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const allChanges: NameStatusEntry[] = [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];

	if (allChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	// from-side 是某 commit ref、to-side 是可变工作树，故 stateKey 须含工作树 fingerprints + untracked
	// （照搬 working_copy 构造）。这让空闲工作树上的每秒轮询坍缩为一次廉价的 fingerprint 比对 → 命中缓存。
	// headCommit 用解析后的 fromRef SHA（而非原始 ref 字符串）：可移动分支作基线时，它移动到新提交、
	// 但工作树侧 name-status 与 fingerprints 不变时，唯有解析后的 SHA 改变才能触发 cache miss。
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	const stateKey = buildWorkspaceChangesStateKey({
		repoRoot,
		headCommit: resolvedFromRef,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const cacheKey = buildWorkspaceChangesCacheKey({ repoRoot, variant: "from_ref", fromRef: input.fromRef });
	const cached = readCachedWorkspaceChanges(cacheKey, stateKey);
	if (cached) {
		return cached;
	}

	const files = await materializeFileChanges(
		allChanges,
		["--find-renames", input.fromRef, "--"],
		repoRoot,
		(entry, statsByPath) => buildFileChangeFromRef(repoRoot, entry, input.fromRef, statsByPath),
	);
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	storeCachedWorkspaceChanges(cacheKey, stateKey, response);
	return response;
}
