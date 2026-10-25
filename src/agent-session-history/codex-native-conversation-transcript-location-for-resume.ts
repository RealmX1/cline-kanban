import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// stream-json 的 CommonJS 导出挂在函数对象上，原生 ESM 不能静态识别其 parser 命名导出。
import streamJson from "stream-json";

// 只枚举文件名；正文读取严格限定到已知原生 ID，不按 cwd 或更新时间猜对话。
export async function listKnownCodexTranscriptSegmentPaths(root: string, sessionId: string): Promise<string[]> {
	const paths: string[] = [];
	const directories = [root];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) break;
		try {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) directories.push(path);
				else if (
					entry.isFile() &&
					(entry.name.endsWith(`${sessionId}.jsonl`) ||
						(entry.name.includes(`${sessionId}_`) && entry.name.endsWith(".jsonl")))
				)
					paths.push(path);
			}
		} catch {
			/* 无法读取的目录不构成任何会话存在的证据。 */
		}
	}
	return paths;
}

// 身份比对只保存有限长度的键和值；其余字符串（尤其 base_instructions）直接消费并丢弃。
// JSON 语法、转义和跨块 UTF-8 由成熟解析器处理，不另写 tokenizer。
function createCodexMetadataIdentityTokenInspector(nativeSessionId: string) {
	let depth = 0;
	let readingPayloadObject = false;
	let readingSourceObject = false;
	let rootKey = "";
	let payloadKey = "";
	let readingKey = false;
	let capturedText = "";
	let capturedStringField = "";
	let recordTypeMatches = false;
	let metadataIdMatches = false;
	let optionalSessionIdMatches = true;
	let sourceIsPersistentMainConversation = true;
	const maximumCapturedTextLength = Math.max(nativeSessionId.length, "memory_consolidation".length) + 1;

	return {
		inspect(token: { name: string; value?: string }) {
			if (token.name === "startKey") {
				readingKey = true;
				capturedText = "";
			} else if (token.name === "stringChunk") {
				if (readingKey || capturedStringField) {
					capturedText = (capturedText + token.value).slice(0, maximumCapturedTextLength);
				}
			} else if (token.name === "endKey") {
				readingKey = false;
				if (depth === 1) {
					rootKey = capturedText;
					if (rootKey === "type") recordTypeMatches = false;
					if (rootKey === "payload") {
						metadataIdMatches = false;
						optionalSessionIdMatches = true;
						sourceIsPersistentMainConversation = true;
					}
				} else if (depth === 2 && readingPayloadObject) {
					payloadKey = capturedText;
					if (payloadKey === "id") metadataIdMatches = false;
					if (payloadKey === "session_id") optionalSessionIdMatches = false;
					if (payloadKey === "source") sourceIsPersistentMainConversation = true;
				} else if (
					depth === 3 &&
					readingSourceObject &&
					(capturedText === "subagent" || capturedText === "internal")
				) {
					sourceIsPersistentMainConversation = false;
				}
			} else if (token.name === "startString") {
				capturedText = "";
				capturedStringField =
					depth === 1 && rootKey === "type"
						? "type"
						: depth === 2 && readingPayloadObject && ["id", "session_id", "source"].includes(payloadKey)
							? payloadKey
							: "";
			} else if (token.name === "endString") {
				if (capturedStringField === "type") recordTypeMatches = capturedText === "session_meta";
				if (capturedStringField === "id") metadataIdMatches = capturedText === nativeSessionId;
				if (capturedStringField === "session_id") optionalSessionIdMatches = capturedText === nativeSessionId;
				if (capturedStringField === "source") {
					sourceIsPersistentMainConversation = !["memory_consolidation", "guardian_review"].includes(capturedText);
				}
				capturedStringField = "";
			} else if (token.name === "startObject" || token.name === "startArray") {
				if (depth === 0 && token.name !== "startObject") recordTypeMatches = false;
				if (depth === 1 && rootKey === "payload") readingPayloadObject = token.name === "startObject";
				if (depth === 2 && readingPayloadObject && payloadKey === "source") {
					readingSourceObject = token.name === "startObject";
				}
				depth += 1;
			} else if (token.name === "endObject" || token.name === "endArray") {
				if (depth === 3) readingSourceObject = false;
				if (depth === 2) readingPayloadObject = false;
				depth -= 1;
			}
		},
		matches: () =>
			recordTypeMatches && metadataIdMatches && optionalSessionIdMatches && sourceIsPersistentMainConversation,
	};
}

async function transcriptEstablishesRequestedCodexConversation(
	path: string,
	nativeSessionId: string,
): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		try {
			const file = await handle.stat();
			if (!file.isFile()) return false;
			const metadataInspectionDeadline = performance.now() + 3_000;
			let foundMetadataLineTerminator = false;
			async function* readMetadataLineChunks() {
				// 以打开时的文件大小封顶，避免不断追加、缺少换行的文件拖住预检。
				for (let position = 0; position < file.size; ) {
					if (performance.now() >= metadataInspectionDeadline) throw new Error("Codex 元数据预检超时");
					const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - position));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
					if (bytesRead === 0) return;
					position += bytesRead;
					const newline = buffer.subarray(0, bytesRead).indexOf(10);
					yield buffer.subarray(0, newline < 0 ? bytesRead : newline);
					if (newline >= 0) {
						foundMetadataLineTerminator = true;
						return;
					}
				}
			}
			const identityInspector = createCodexMetadataIdentityTokenInspector(nativeSessionId);
			await pipeline(
				Readable.from(readMetadataLineChunks()),
				streamJson.parser({ packValues: false }),
				async (tokens) => {
					for await (const token of tokens) identityInspector.inspect(token);
				},
			);
			return foundMetadataLineTerminator && identityInspector.matches();
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

export async function inspectCodexNativeConversationTranscriptBeforeResume(input: {
	nativeSessionId: string;
	transcriptPath: string | null | undefined;
	agentExecutionWorkingDirectoryPath?: string;
	environmentOverrides?: Partial<Pick<NodeJS.ProcessEnv, "CODEX_HOME" | "HOME">>;
}): Promise<{ persistedTranscriptPath: string | null; codexSessionsDirectoryPath: string }> {
	const environment = { ...process.env, ...input.environmentOverrides };
	const configuredCodexHome = environment.CODEX_HOME?.trim();
	// 相对 CODEX_HOME 与即将启动的 agent 共用 cwd；未提供执行目录的历史消费者保持原语义。
	const codexHome = configuredCodexHome
		? resolve(input.agentExecutionWorkingDirectoryPath ?? process.cwd(), configuredCodexHome)
		: join(environment.HOME?.trim() || homedir(), ".codex");
	const root = resolve(codexHome, "sessions");
	const isWithinEffectiveCodexStore = (path: string): boolean => {
		const pathRelativeToStore = relative(root, resolve(path));
		return (
			pathRelativeToStore !== ".." && !pathRelativeToStore.startsWith(`..${sep}`) && !isAbsolute(pathRelativeToStore)
		);
	};
	if (
		input.transcriptPath &&
		isWithinEffectiveCodexStore(input.transcriptPath) &&
		(await transcriptEstablishesRequestedCodexConversation(input.transcriptPath, input.nativeSessionId))
	)
		return { persistedTranscriptPath: input.transcriptPath, codexSessionsDirectoryPath: root };
	for (const path of await listKnownCodexTranscriptSegmentPaths(root, input.nativeSessionId)) {
		if (await transcriptEstablishesRequestedCodexConversation(path, input.nativeSessionId))
			return { persistedTranscriptPath: path, codexSessionsDirectoryPath: root };
	}
	return { persistedTranscriptPath: null, codexSessionsDirectoryPath: root };
}
