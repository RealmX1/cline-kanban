import { spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { TRPCError } from "@trpc/server";
import type { RuntimeTaskDirectoryResponse } from "../core/api-contract";

function isWithinDirectory(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function taskFileAccessError(error: unknown): TRPCError {
	if (error instanceof TRPCError) return error;
	const code = (error as NodeJS.ErrnoException).code;
	const permissionDenied = code === "EACCES" || code === "EPERM";
	return new TRPCError({
		code: permissionDenied || code === "ELOOP" ? "FORBIDDEN" : "NOT_FOUND",
		message: permissionDenied
			? "没有读取此文件或目录的权限。"
			: code === "ELOOP"
				? "不能访问任务工作目录外的符号链接。"
				: "文件或目录不存在、已删除或暂不可读，请刷新后重试。",
		cause: error,
	});
}

async function resolveTaskPath(root: string, path: string): Promise<string> {
	if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes(".."))
		throw new TRPCError({ code: "FORBIDDEN", message: "文件路径必须位于任务工作目录内。" });
	const canonicalRoot = await realpath(root);
	const canonicalPath = await realpath(resolve(canonicalRoot, path));
	if (!isWithinDirectory(canonicalRoot, canonicalPath))
		throw new TRPCError({ code: "FORBIDDEN", message: "不能访问任务工作目录外的符号链接。" });
	return canonicalPath;
}

// macOS 11+。拒绝路径中任一符号链接；不能和 O_NOFOLLOW 同时使用，后者组合会 EINVAL。
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const DARWIN_DIRECTORY_TYPE = { unknown: 0, directory: 4, file: 8, symlink: 10 } as const;
// SYS_getdirentries64。只解析内核 dirent64，名称按 d_namlen 取字节，不按换行切分。
const DARWIN_DIRECTORY_RECORDS_SCRIPT = [
	"use strict;",
	"binmode STDOUT;",
	"my $fd = 3;",
	String.raw`my $buffer = "\0" x 65536;`,
	'my $base = pack("Q", 0);',
	"while (1) {",
	"my $count = syscall(344, $fd, $buffer, length($buffer), $base);",
	'if (!defined($count) || $count < 0) { die "getdirentries: $!"; }',
	"last if $count == 0;",
	'syswrite(STDOUT, substr($buffer, 0, $count)) == $count or die "short write";',
	"}",
].join("\n");

interface DirectoryEntrySource {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

function outsideSymlinkError(): TRPCError {
	return new TRPCError({ code: "FORBIDDEN", message: "不能访问任务工作目录外的符号链接。" });
}

function directoryDescriptorUnavailable(cause?: unknown): TRPCError {
	return new TRPCError({
		code: "FORBIDDEN",
		message: "无法核验已打开目录的实际内容，已拒绝列出。",
		cause,
	});
}

function regularFileOpenFlags(): number {
	const flags = constants.O_RDONLY | constants.O_NONBLOCK;
	return process.platform === "darwin" ? flags | DARWIN_O_NOFOLLOW_ANY : flags | constants.O_NOFOLLOW;
}

function directoryOpenFlags(): number {
	const flags = constants.O_RDONLY | constants.O_DIRECTORY;
	return process.platform === "darwin" ? flags | DARWIN_O_NOFOLLOW_ANY : flags | constants.O_NOFOLLOW;
}

function darwinDirectoryEntries(records: Buffer): DirectoryEntrySource[] {
	const entries: DirectoryEntrySource[] = [];
	let offset = 0;
	while (offset < records.length) {
		if (offset + 21 > records.length) throw directoryDescriptorUnavailable();
		const recordLength = records.readUInt16LE(offset + 16);
		const nameLength = records.readUInt16LE(offset + 18);
		const type = records[offset + 20] ?? DARWIN_DIRECTORY_TYPE.unknown;
		const recordIsComplete =
			recordLength >= 21 && offset + recordLength <= records.length && nameLength <= recordLength - 21;
		if (!recordIsComplete) throw directoryDescriptorUnavailable();
		const nameBytes = records.subarray(offset + 21, offset + 21 + nameLength);
		const name = nameBytes.toString("utf8");
		offset += recordLength;
		if (name === "." || name === "..") continue;
		if (nameBytes.includes(0) || Buffer.byteLength(name) !== nameLength) throw directoryDescriptorUnavailable();
		entries.push({
			name,
			isDirectory: () => type === DARWIN_DIRECTORY_TYPE.directory,
			isFile: () => type === DARWIN_DIRECTORY_TYPE.file,
			isSymbolicLink: () => type === DARWIN_DIRECTORY_TYPE.symlink,
		});
	}
	return entries;
}

function readDarwinDirectory(fd: number): Promise<DirectoryEntrySource[]> {
	const child = spawn("/usr/bin/perl", ["-e", DARWIN_DIRECTORY_RECORDS_SCRIPT], {
		stdio: ["ignore", "pipe", "pipe", fd],
	});
	const stdout: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer | string) => {
		stdout.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	});
	return new Promise((resolveEntries, rejectEntries) => {
		const timeout = setTimeout(() => {
			child.kill();
			rejectEntries(directoryDescriptorUnavailable());
		}, 5000);
		child.once("error", (error: Error) => {
			clearTimeout(timeout);
			rejectEntries(directoryDescriptorUnavailable(error));
		});
		child.once("close", (status) => {
			clearTimeout(timeout);
			if (status !== 0) rejectEntries(directoryDescriptorUnavailable());
			else resolveEntries(darwinDirectoryEntries(Buffer.concat(stdout)));
		});
	});
}

async function readOpenedDirectory(handle: FileHandle, canonicalRoot: string): Promise<DirectoryEntrySource[]> {
	if (process.platform === "linux") {
		const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
		if (!isWithinDirectory(canonicalRoot, openedPath)) throw outsideSymlinkError();
		return readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
	}
	if (process.platform === "darwin") return readDarwinDirectory(handle.fd);
	throw directoryDescriptorUnavailable();
}

async function describeDirectoryEntry(
	root: string,
	directoryPath: string,
	entry: DirectoryEntrySource | Dirent,
): Promise<RuntimeTaskDirectoryResponse["entries"][number]> {
	const entryPath = directoryPath ? `${directoryPath}/${entry.name}` : entry.name;
	let isDirectory = entry.isDirectory();
	if (entry.isSymbolicLink()) {
		try {
			isDirectory = (await stat(await resolveTaskPath(root, entryPath))).isDirectory();
		} catch {
			/* 不暴露目录外或已失效链接的目标。 */
		}
	}
	return {
		name: entry.name,
		path: entryPath,
		kind: isDirectory ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "unsupported",
	};
}

export async function listTaskDirectory(root: string, path: string): Promise<RuntimeTaskDirectoryResponse> {
	let handle: FileHandle | null = null;
	try {
		const canonicalRoot = await realpath(root);
		const canonicalPath = await resolveTaskPath(root, path);
		handle = await open(canonicalPath, directoryOpenFlags());
		const opened = await handle.stat();
		if (!opened.isDirectory()) throw new Error("不是目录");
		const entries = await readOpenedDirectory(handle, canonicalRoot);
		const directoryEntries = await Promise.all(entries.map((entry) => describeDirectoryEntry(root, path, entry)));
		return {
			path,
			entries: directoryEntries.sort(
				(a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
			),
		};
	} catch (error) {
		throw taskFileAccessError(error);
	} finally {
		await handle?.close();
	}
}

export interface OpenedTaskFileDownload {
	handle: FileHandle;
	fileName: string;
	size: number;
}

function changedFileError(): TRPCError {
	return new TRPCError({ code: "CONFLICT", message: "文件在读取时发生变化，请重试。" });
}

// 目录外计划只能传入经过主会话历史核验的精确路径，HTTP 输入不能直接进入此入口。
// 先 realpath 再打开：macOS 用 O_NOFOLLOW_ANY 拒绝任一组件的符号链接，Linux 用描述符真实路径复核。
export async function openTaskRegularFile(root: string | null, path: string): Promise<OpenedTaskFileDownload> {
	let handle: FileHandle | null = null;
	try {
		const canonicalPath = root === null ? await realpath(path) : await resolveTaskPath(root, path);
		const before = await stat(canonicalPath);
		if (!before.isFile())
			throw new TRPCError({ code: "FORBIDDEN", message: "只能下载普通文件，目录和特殊设备文件不可下载。" });
		handle = await open(canonicalPath, regularFileOpenFlags());
		const opened = await handle.stat();
		if (process.platform === "linux") {
			const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
			if (openedPath !== canonicalPath) {
				const canonicalRoot = root === null ? null : await realpath(root);
				if (canonicalRoot && !isWithinDirectory(canonicalRoot, openedPath)) throw outsideSymlinkError();
				throw changedFileError();
			}
		}
		const currentPath = root === null ? await realpath(path) : await resolveTaskPath(root, path);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || currentPath !== canonicalPath)
			throw changedFileError();
		return { handle, fileName: basename(path), size: opened.size };
	} catch (error) {
		await handle?.close();
		throw taskFileAccessError(error);
	}
}
