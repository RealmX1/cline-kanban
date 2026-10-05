// agent session PTY host 的 socket 路径与 generation 发现。
//
// 一个「runtime 身份」= runtime home（~/.cline/kanban，随 HOME 覆写隔离）+ 固定端口。同一身份下每个 host build
// 一个 generation：socket 文件名带 build identity 前 12 位。新 build 的会话进新 generation，旧 host 只服务存量会话，
// 排空后自行退出。runtime 启动时枚举本身份下的全部 generation socket。
//
// macOS 的 sun_path 上限是 104 字节（含结尾 NUL）。HOME 覆写到很深的临时目录时主路径可能超长，
// 此时改放 /tmp/kanban-agent-session-pty-host-<uid>/，文件名再加 runtime home 的哈希以区分身份。
// /tmp 开机即清空不是问题：host 本身也活不过重启。

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MAXIMUM_UNIX_DOMAIN_SOCKET_PATH_BYTE_LENGTH = 103;
const AGENT_SESSION_PTY_HOST_BUILD_IDENTITY_PREFIX_LENGTH_IN_SOCKET_FILE_NAME = 12;

export interface AgentSessionPtyHostRuntimeIdentity {
	runtimeHomeDirectoryPath: string;
	runtimePort: number;
}

interface AgentSessionPtyHostSocketNaming {
	socketDirectoryPath: string;
	socketFileNamePrefix: string;
}

function hashTextToTwelveHexCharacters(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function resolveSocketNamingInRuntimeHome(
	identity: AgentSessionPtyHostRuntimeIdentity,
): AgentSessionPtyHostSocketNaming {
	return {
		socketDirectoryPath: join(identity.runtimeHomeDirectoryPath, "agent-session-pty-host"),
		socketFileNamePrefix: `p${identity.runtimePort}-`,
	};
}

function resolveSocketNamingInShortTemporaryDirectory(
	identity: AgentSessionPtyHostRuntimeIdentity,
): AgentSessionPtyHostSocketNaming {
	const userIdentifier = typeof process.getuid === "function" ? process.getuid() : 0;
	return {
		socketDirectoryPath: `/tmp/kanban-agent-session-pty-host-${userIdentifier}`,
		socketFileNamePrefix: `${hashTextToTwelveHexCharacters(identity.runtimeHomeDirectoryPath)}-p${identity.runtimePort}-`,
	};
}

function buildSocketFileName(naming: AgentSessionPtyHostSocketNaming, hostBuildIdentity: string): string {
	return `${naming.socketFileNamePrefix}${hostBuildIdentity.slice(0, AGENT_SESSION_PTY_HOST_BUILD_IDENTITY_PREFIX_LENGTH_IN_SOCKET_FILE_NAME)}.sock`;
}

// 以「最长可能的文件名」判定该用哪套命名：同一身份下所有 generation 必须落在同一个目录里才能被枚举到。
function resolveSocketNaming(identity: AgentSessionPtyHostRuntimeIdentity): AgentSessionPtyHostSocketNaming {
	const runtimeHomeNaming = resolveSocketNamingInRuntimeHome(identity);
	const longestSocketPath = join(
		runtimeHomeNaming.socketDirectoryPath,
		buildSocketFileName(
			runtimeHomeNaming,
			"f".repeat(AGENT_SESSION_PTY_HOST_BUILD_IDENTITY_PREFIX_LENGTH_IN_SOCKET_FILE_NAME),
		),
	);
	if (Buffer.byteLength(longestSocketPath, "utf8") <= MAXIMUM_UNIX_DOMAIN_SOCKET_PATH_BYTE_LENGTH) {
		return runtimeHomeNaming;
	}
	return resolveSocketNamingInShortTemporaryDirectory(identity);
}

export function resolveAgentSessionPtyHostSocketPath(
	identity: AgentSessionPtyHostRuntimeIdentity,
	hostBuildIdentity: string,
): string {
	const naming = resolveSocketNaming(identity);
	return join(naming.socketDirectoryPath, buildSocketFileName(naming, hostBuildIdentity));
}

export function resolveAgentSessionPtyHostLogFilePath(identity: AgentSessionPtyHostRuntimeIdentity): string {
	return join(
		identity.runtimeHomeDirectoryPath,
		"agent-session-pty-host",
		"logs",
		`p${identity.runtimePort}-agent-session-pty-host.log`,
	);
}

// 本 runtime 身份下现存的全部 generation socket（不保证对端还活着：host 被 SIGKILL 后 socket 文件会残留）。
export function listAgentSessionPtyHostGenerationSocketPaths(identity: AgentSessionPtyHostRuntimeIdentity): string[] {
	const naming = resolveSocketNaming(identity);
	let directoryEntryNames: string[];
	try {
		directoryEntryNames = readdirSync(naming.socketDirectoryPath);
	} catch {
		return [];
	}
	const generationSocketFileNamePattern = new RegExp(
		`^${naming.socketFileNamePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{${AGENT_SESSION_PTY_HOST_BUILD_IDENTITY_PREFIX_LENGTH_IN_SOCKET_FILE_NAME}}\\.sock$`,
	);
	return directoryEntryNames
		.filter((entryName) => generationSocketFileNamePattern.test(entryName))
		.sort()
		.map((entryName) => join(naming.socketDirectoryPath, entryName));
}
