import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";
import {
	type SourceGitWorkingStateSnapshot,
	sourceGitWorkingStateSnapshotSchema,
} from "../independent-task-creation/git-working-state-snapshot";
import { getGitStdout } from "../workspace/git-utils";

const fingerprintPreservedFileContent = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const createUnpreservedCandidateContentError = (path: string) =>
	new Error(`未验证候选含有来源未覆盖或归属未知的内容，保留载荷：${path}`);

async function fingerprintSourceReachableGitObjectPack(
	sourceWorktreePath: string,
	headCommit: string,
	maximumSourceObjectPackProofOutputBytes: number,
) {
	const sourceGitProcessEnvironment = createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" });
	const stagedEntries = await getGitStdout(
		["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"],
		sourceWorktreePath,
		{ timeoutMs: 30_000, env: sourceGitProcessEnvironment },
	);
	const stagedObjectIds = stagedEntries.split("\0").flatMap((entry) => {
		const objectId = entry.match(/^\d+ ([a-f0-9]+) /u)?.[1];
		return objectId && !/^0+$/u.test(objectId) ? [objectId] : [];
	});
	// 同捕获时的只读 pack 流比较；不创建索引或暂存，硬退出也没有需认领的磁盘写入者。
	const proofChildProcess = spawn("git", ["pack-objects", "--stdout", "--revs", "--threads=1"], {
		cwd: sourceWorktreePath,
		env: sourceGitProcessEnvironment,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const sourceObjectPackHash = createHash("sha256");
	let generatedObjectPackByteCount = 0;
	let gitProofStderr = "";
	let gitProofFailure: Error | null = null;
	const terminateSourceGitObjectPackProof = (error: Error) => {
		gitProofFailure ??= error;
		proofChildProcess.kill("SIGKILL");
	};
	const proofDeadlineTimer = setTimeout(
		() => terminateSourceGitObjectPackProof(new Error("来源 Git 对象证明超过时限，保留候选。")),
		30_000,
	);
	try {
		await new Promise<void>((resolveExit, rejectExit) => {
			proofChildProcess.once("error", (error) => {
				gitProofFailure ??= error;
			});
			proofChildProcess.stdin.once("error", terminateSourceGitObjectPackProof);
			proofChildProcess.stderr.on("data", (chunk) => {
				gitProofStderr = `${gitProofStderr}${String(chunk)}`.slice(-4000);
			});
			proofChildProcess.stdout.on("data", (chunk: Buffer) => {
				generatedObjectPackByteCount += chunk.length;
				if (generatedObjectPackByteCount > maximumSourceObjectPackProofOutputBytes)
					terminateSourceGitObjectPackProof(new Error("来源 Git 对象证明超过候选体积，保留载荷。"));
				else sourceObjectPackHash.update(chunk);
			});
			proofChildProcess.once("close", (code) => {
				if (gitProofFailure) rejectExit(gitProofFailure);
				else if (code !== 0) rejectExit(new Error(`来源 Git 对象证明失败，保留载荷：${gitProofStderr}`));
				else resolveExit();
			});
			proofChildProcess.stdin.end(`${[headCommit, ...new Set(stagedObjectIds)].join("\n")}\n`);
		});
		return sourceObjectPackHash.digest("hex");
	} finally {
		clearTimeout(proofDeadlineTimer);
	}
}

/** 删除前逐项证明当前载荷；中断留下的文件前缀可回收，未知文件和独有 Git 对象必须保留。 */
export async function assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives(
	candidateDirectoryPath: string,
	sourceWorktreePath: string,
	sourceCaptureInventory: SourceGitWorkingStateSnapshot,
) {
	const workingEntries = new Map(
		sourceCaptureInventory.entries.filter((entry) => entry.kind !== "absent").map((entry) => [entry.path, entry]),
	);
	const expectedWorkingDirectories = new Set<string>(["working-files"]);
	for (const path of workingEntries.keys())
		for (let parent = dirname(join("working-files", path)); parent !== "."; parent = dirname(parent))
			expectedWorkingDirectories.add(parent);
	const gitIndexPath = await getGitStdout(
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		sourceWorktreePath,
	);
	const assertCandidateFileContainsOnlySourcePrefix = async (path: string, original: Buffer) => {
		const candidateFilePath = join(candidateDirectoryPath, path);
		const candidateMetadata = await lstat(candidateFilePath);
		if (!candidateMetadata.isFile() || candidateMetadata.size > original.length)
			throw createUnpreservedCandidateContentError(path);
		const actual = await readFile(candidateFilePath);
		if (actual.length > original.length || !actual.equals(original.subarray(0, actual.length)))
			throw createUnpreservedCandidateContentError(path);
	};
	const inspectCandidateDirectoryContents = async (prefix = "") => {
		for (const name of await readdir(join(candidateDirectoryPath, prefix))) {
			const path = prefix ? `${prefix}/${name}` : name;
			const absolute = join(candidateDirectoryPath, path);
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) throw createUnpreservedCandidateContentError(path);
			if (info.isDirectory()) {
				if (!expectedWorkingDirectories.has(path)) throw createUnpreservedCandidateContentError(path);
				await inspectCandidateDirectoryContents(path);
				continue;
			}
			if (!info.isFile()) throw createUnpreservedCandidateContentError(path);
			if (path.startsWith("working-files/")) {
				const relativePath = path.slice("working-files/".length);
				const expected = workingEntries.get(relativePath);
				if (!expected) throw createUnpreservedCandidateContentError(path);
				const original =
					expected.kind === "symlink"
						? Buffer.from(await readlink(join(sourceWorktreePath, relativePath)))
						: await readFile(join(sourceWorktreePath, relativePath));
				if (fingerprintPreservedFileContent(original) !== expected.hash)
					throw createUnpreservedCandidateContentError(path);
				await assertCandidateFileContainsOnlySourcePrefix(path, original);
			} else if (path === "source-git-index") {
				const original = await readFile(gitIndexPath);
				if (fingerprintPreservedFileContent(original) !== sourceCaptureInventory.indexHash)
					throw createUnpreservedCandidateContentError(path);
				await assertCandidateFileContainsOnlySourcePrefix(path, original);
			} else if (path === "source-git-shared-index" && sourceCaptureInventory.sharedIndexName) {
				await assertCandidateFileContainsOnlySourcePrefix(
					path,
					await readFile(join(dirname(gitIndexPath), sourceCaptureInventory.sharedIndexName)),
				);
			} else if (["git-working-state-capture-inventory.json", "git-working-state.json"].includes(path)) {
				if (info.size > Buffer.byteLength(JSON.stringify(sourceCaptureInventory)) + 256)
					throw createUnpreservedCandidateContentError(path);
				const { objectPackHash: _objectPackHash, ...candidateInventory } =
					sourceGitWorkingStateSnapshotSchema.parse(JSON.parse(await readFile(absolute, "utf8")));
				const { objectPackHash: _inventoryPackHash, ...sourceInventory } = sourceCaptureInventory;
				if (!isDeepStrictEqual(candidateInventory, sourceInventory))
					throw createUnpreservedCandidateContentError(path);
			} else if (path === "source-git-objects.pack") {
				const candidatePackHash = createHash("sha256");
				let candidatePackBytes = 0;
				for await (const chunk of createReadStream(absolute)) {
					candidatePackBytes += chunk.length;
					if (candidatePackBytes > info.size) throw createUnpreservedCandidateContentError(path);
					candidatePackHash.update(chunk);
				}
				if (candidatePackBytes !== info.size) throw createUnpreservedCandidateContentError(path);
				const sourcePackHash = await fingerprintSourceReachableGitObjectPack(
					sourceWorktreePath,
					sourceCaptureInventory.headCommit,
					info.size,
				);
				// pack 布局变化也保守保留；只有完整字节均可从当前受覆盖来源重建时才允许回收。
				if (candidatePackHash.digest("hex") !== sourcePackHash) throw createUnpreservedCandidateContentError(path);
			} else throw createUnpreservedCandidateContentError(path);
		}
	};
	await inspectCandidateDirectoryContents();
}
