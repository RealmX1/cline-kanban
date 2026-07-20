import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { onTestFinished } from "vitest";

export interface ProtectedFilesystemMutationTestFixture {
	fixtureRootDirectoryPath: string;
	ownedMutationSandboxDirectoryPath: string;
	protectedSiblingDirectoryPath: string;
	protectedSiblingSentinelFilePath: string;
	createOwnedMutationDirectory(options: { ownedDirectoryName: string }): string;
	createSymlinkEscapeCandidate(options: { symlinkName: string }): string;
	assertProtectedCanariesIntact(): void;
	cleanup(): void;
}

interface FilesystemIdentity {
	device: number;
	inode: number;
	realPath: string;
}

function captureFilesystemIdentity(path: string): FilesystemIdentity {
	const entry = lstatSync(path);
	return { device: entry.dev, inode: entry.ino, realPath: realpathSync(path) };
}

function isPathInsideOrEqualToRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath = relative(rootPath, candidatePath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function assertSimpleOwnedDirectoryName(directoryName: string, description: string): void {
	if (
		directoryName.length === 0 ||
		directoryName === "." ||
		directoryName === ".." ||
		basename(directoryName) !== directoryName
	) {
		throw new Error(`${description} must be one non-empty directory name without path separators`);
	}
}

export function createProtectedFilesystemMutationTestFixture(
	options: { parentDirectoryPath?: string } = {},
): ProtectedFilesystemMutationTestFixture {
	const parentDirectoryRealPath = realpathSync(options.parentDirectoryPath ?? tmpdir());
	const fixtureRootDirectoryPath = mkdtempSync(
		join(parentDirectoryRealPath, "cline-kanban-protected-filesystem-mutation-test-"),
	);
	const fixtureRootFilesystemIdentity = captureFilesystemIdentity(fixtureRootDirectoryPath);
	const ownedMutationSandboxDirectoryPath = join(fixtureRootDirectoryPath, "owned-mutation-sandbox");
	const protectedSiblingDirectoryPath = join(fixtureRootDirectoryPath, "protected-sibling-directory");
	mkdirSync(ownedMutationSandboxDirectoryPath);
	mkdirSync(protectedSiblingDirectoryPath);
	const protectedSiblingDirectoryFilesystemIdentity = captureFilesystemIdentity(protectedSiblingDirectoryPath);
	const protectedSiblingSentinelFilePath = join(protectedSiblingDirectoryPath, "protected-sibling-sentinel.txt");
	const protectedSiblingSentinelContents = `protected:${basename(fixtureRootDirectoryPath)}\n`;
	writeFileSync(protectedSiblingSentinelFilePath, protectedSiblingSentinelContents, { flag: "wx" });
	const protectedSiblingSentinelFilesystemIdentity = captureFilesystemIdentity(protectedSiblingSentinelFilePath);
	let cleanupCompleted = false;

	function assertFilesystemIdentity(path: string, expectedIdentity: FilesystemIdentity, description: string): void {
		const currentIdentity = captureFilesystemIdentity(path);
		if (
			currentIdentity.device !== expectedIdentity.device ||
			currentIdentity.inode !== expectedIdentity.inode ||
			currentIdentity.realPath !== expectedIdentity.realPath
		) {
			throw new Error(`${description} filesystem identity changed: ${path}`);
		}
	}

	function assertProtectedCanariesIntact(): void {
		assertFilesystemIdentity(
			protectedSiblingDirectoryPath,
			protectedSiblingDirectoryFilesystemIdentity,
			"Protected sibling directory",
		);
		assertFilesystemIdentity(
			protectedSiblingSentinelFilePath,
			protectedSiblingSentinelFilesystemIdentity,
			"Protected sibling sentinel",
		);
		if (readFileSync(protectedSiblingSentinelFilePath, "utf8") !== protectedSiblingSentinelContents) {
			throw new Error(`Protected sibling sentinel contents changed: ${protectedSiblingSentinelFilePath}`);
		}
	}

	function cleanup(): void {
		if (cleanupCompleted) {
			return;
		}
		assertFilesystemIdentity(fixtureRootDirectoryPath, fixtureRootFilesystemIdentity, "Fixture root");
		assertProtectedCanariesIntact();
		rmSync(fixtureRootDirectoryPath, { recursive: true, force: false, maxRetries: 15, retryDelay: 100 });
		cleanupCompleted = true;
	}

	const fixture: ProtectedFilesystemMutationTestFixture = {
		fixtureRootDirectoryPath,
		ownedMutationSandboxDirectoryPath,
		protectedSiblingDirectoryPath,
		protectedSiblingSentinelFilePath,
		createOwnedMutationDirectory(options) {
			assertSimpleOwnedDirectoryName(options.ownedDirectoryName, "ownedDirectoryName");
			const ownedDirectoryPath = join(ownedMutationSandboxDirectoryPath, options.ownedDirectoryName);
			if (!isPathInsideOrEqualToRoot(ownedDirectoryPath, ownedMutationSandboxDirectoryPath)) {
				throw new Error(`Owned mutation directory escaped its sandbox: ${ownedDirectoryPath}`);
			}
			mkdirSync(ownedDirectoryPath);
			return realpathSync(ownedDirectoryPath);
		},
		createSymlinkEscapeCandidate(options) {
			assertSimpleOwnedDirectoryName(options.symlinkName, "symlinkName");
			const symlinkPath = join(ownedMutationSandboxDirectoryPath, options.symlinkName);
			if (existsSync(symlinkPath)) {
				throw new Error(`Symlink escape candidate already exists: ${symlinkPath}`);
			}
			symlinkSync(protectedSiblingDirectoryPath, symlinkPath, "dir");
			return symlinkPath;
		},
		assertProtectedCanariesIntact,
		cleanup,
	};

	onTestFinished(cleanup);
	return fixture;
}
