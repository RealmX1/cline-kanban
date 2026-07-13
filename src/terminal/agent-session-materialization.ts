import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, link, lstat, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeTaskAgentSessionInitialization } from "../core/api-contract";

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await access(pathValue, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function encodeClaudeProjectWorkingDirectoryPath(workingDirectoryPath: string): string {
	return resolve(workingDirectoryPath).replace(/[^a-zA-Z0-9]/gu, "-");
}

function hashCursorChatWorkingDirectoryPath(workingDirectoryPath: string): string {
	return createHash("md5").update(resolve(workingDirectoryPath)).digest("hex");
}

async function canonicalizeWorkingDirectoryPath(workingDirectoryPath: string): Promise<string> {
	try {
		return await realpath(workingDirectoryPath);
	} catch {
		return resolve(workingDirectoryPath);
	}
}

async function findNewestExistingPath(candidatePaths: string[]): Promise<string | null> {
	const existingCandidates = await Promise.all(
		candidatePaths.map(async (candidatePath) => {
			try {
				return { candidatePath, modifiedAt: (await stat(candidatePath)).mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	return (
		existingCandidates
			.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
			.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.candidatePath ?? null
	);
}

async function readDirectories(directoryPath: string): Promise<Dirent[]> {
	try {
		return (await readdir(directoryPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	} catch {
		return [];
	}
}

async function findClaudeSourceTranscriptPath(
	initialization: RuntimeTaskAgentSessionInitialization,
	targetTranscriptPath: string,
): Promise<string | null> {
	const claudeProjectsDirectoryPath = join(homedir(), ".claude", "projects");
	const preferredSourceWorkingDirectoryPath = initialization.sourceSessionWorkingDirectoryPath;
	if (preferredSourceWorkingDirectoryPath) {
		const canonicalSourceWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
			preferredSourceWorkingDirectoryPath,
		);
		const preferredSourceTranscriptPath = join(
			claudeProjectsDirectoryPath,
			encodeClaudeProjectWorkingDirectoryPath(canonicalSourceWorkingDirectoryPath),
			`${initialization.sourceSessionId}.jsonl`,
		);
		if (
			resolve(preferredSourceTranscriptPath) !== resolve(targetTranscriptPath) &&
			(await pathExists(preferredSourceTranscriptPath))
		) {
			return preferredSourceTranscriptPath;
		}
	}
	const projectDirectories = await readDirectories(claudeProjectsDirectoryPath);
	return findNewestExistingPath(
		projectDirectories
			.map((projectDirectory) =>
				join(claudeProjectsDirectoryPath, projectDirectory.name, `${initialization.sourceSessionId}.jsonl`),
			)
			.filter((candidatePath) => resolve(candidatePath) !== resolve(targetTranscriptPath)),
	);
}

async function findCursorSourceChatDirectoryPath(
	initialization: RuntimeTaskAgentSessionInitialization,
	targetChatDirectoryPath: string,
): Promise<string | null> {
	const cursorChatsDirectoryPath = join(homedir(), ".cursor", "chats");
	const preferredSourceWorkingDirectoryPath = initialization.sourceSessionWorkingDirectoryPath;
	if (preferredSourceWorkingDirectoryPath) {
		const canonicalSourceWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
			preferredSourceWorkingDirectoryPath,
		);
		const preferredSourceChatDirectoryPath = join(
			cursorChatsDirectoryPath,
			hashCursorChatWorkingDirectoryPath(canonicalSourceWorkingDirectoryPath),
			initialization.sourceSessionId,
		);
		if (
			resolve(preferredSourceChatDirectoryPath) !== resolve(targetChatDirectoryPath) &&
			(await pathExists(join(preferredSourceChatDirectoryPath, "store.db")))
		) {
			return preferredSourceChatDirectoryPath;
		}
	}
	const workspaceHashDirectories = await readDirectories(cursorChatsDirectoryPath);
	const candidateChatDirectoryPaths = workspaceHashDirectories
		.map((workspaceHashDirectory) =>
			join(cursorChatsDirectoryPath, workspaceHashDirectory.name, initialization.sourceSessionId),
		)
		.filter((candidatePath) => resolve(candidatePath) !== resolve(targetChatDirectoryPath));
	const validCandidateChatDirectoryPaths = (
		await Promise.all(
			candidateChatDirectoryPaths.map(async (candidatePath) =>
				(await pathExists(join(candidatePath, "store.db"))) ? candidatePath : null,
			),
		)
	).filter((candidatePath): candidatePath is string => candidatePath !== null);
	return findNewestExistingPath(validCandidateChatDirectoryPaths);
}

async function ensureSessionStorageReference(
	sourcePath: string,
	targetPath: string,
	referenceKind: "file_hard_link" | "directory_symbolic_link",
): Promise<void> {
	await mkdir(resolve(targetPath, ".."), { recursive: true });
	const targetReferencesSource = async (): Promise<boolean> => {
		if (referenceKind === "file_hard_link") {
			const [targetMetadata, sourceMetadata] = await Promise.all([stat(targetPath), stat(sourcePath)]);
			return targetMetadata.dev === sourceMetadata.dev && targetMetadata.ino === sourceMetadata.ino;
		}
		const sourceRealPath = await realpath(sourcePath);
		try {
			return (await realpath(targetPath)) === sourceRealPath;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return false;
			}
			throw error;
		}
	};
	try {
		await lstat(targetPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
		try {
			if (referenceKind === "file_hard_link") {
				await link(sourcePath, targetPath);
			} else {
				await symlink(sourcePath, targetPath, "dir");
			}
		} catch (creationError) {
			if (!(creationError instanceof Error && "code" in creationError && creationError.code === "EEXIST")) {
				throw creationError;
			}
			if (!(await targetReferencesSource())) {
				throw new Error(`Session storage was concurrently created at ${targetPath} from a different source.`);
			}
		}
		return;
	}
	if (!(await targetReferencesSource())) {
		throw new Error(`Session storage already exists at ${targetPath} and points to a different session source.`);
	}
}

export async function materializeTaskAgentSessionForExecutionWorkingDirectory(input: {
	initialization: RuntimeTaskAgentSessionInitialization | undefined;
	executionWorkingDirectoryPath: string;
}): Promise<void> {
	const { initialization } = input;
	if (!initialization || initialization.sourceAgentId === "codex") {
		return;
	}
	const canonicalExecutionWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
		input.executionWorkingDirectoryPath,
	);
	if (initialization.sourceAgentId === "claude") {
		const targetTranscriptPath = join(
			homedir(),
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(canonicalExecutionWorkingDirectoryPath),
			`${initialization.sourceSessionId}.jsonl`,
		);
		const targetTranscriptExists = await pathExists(targetTranscriptPath);
		const sourceTranscriptPath = await findClaudeSourceTranscriptPath(initialization, targetTranscriptPath);
		if (!sourceTranscriptPath) {
			if (targetTranscriptExists) {
				return;
			}
			throw new Error(
				`Claude Code session ${initialization.sourceSessionId} was not found in local project history.`,
			);
		}
		await ensureSessionStorageReference(sourceTranscriptPath, targetTranscriptPath, "file_hard_link");
		return;
	}

	const targetChatDirectoryPath = join(
		homedir(),
		".cursor",
		"chats",
		hashCursorChatWorkingDirectoryPath(canonicalExecutionWorkingDirectoryPath),
		initialization.sourceSessionId,
	);
	const targetChatStoreExists = await pathExists(join(targetChatDirectoryPath, "store.db"));
	const sourceChatDirectoryPath = await findCursorSourceChatDirectoryPath(initialization, targetChatDirectoryPath);
	if (!sourceChatDirectoryPath || !(await pathExists(join(sourceChatDirectoryPath, "store.db")))) {
		if (targetChatStoreExists) {
			return;
		}
		throw new Error(`Cursor session ${initialization.sourceSessionId} was not found in local chat storage.`);
	}
	await ensureSessionStorageReference(sourceChatDirectoryPath, targetChatDirectoryPath, "directory_symbolic_link");
}
