import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
// stream-json 的 CommonJS 导出挂在函数对象上，原生 ESM 不能静态识别其 parser 命名导出。
import streamJson from "stream-json";
import { countDailyWorkProgressCollectionCost } from "../diagnostics/daily-work-progress-collection-cost-recorder";
import {
	assertCodexTranscriptNativeStoragePathOwnership,
	codexTranscriptJsonlPath,
	readCodexDecodedTranscriptChunks,
} from "./codex-transcript-read-source";

// 只枚举文件名；正文读取严格限定到已知原生 ID，不按 cwd 或更新时间猜对话。
export async function listKnownCodexTranscriptSegmentPaths(
	root: string,
	sessionId: string,
	options: { includeCompressedTranscripts?: boolean } = {},
): Promise<string[]> {
	const paths: string[] = [];
	const directories = [root];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) break;
		try {
			countDailyWorkProgressCollectionCost("codex_directory_enumerations");
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				// 写入/迁移消费者保留 JSONL 默认；共享只读消费者显式包含压缩格式。
				const transcriptName =
					options.includeCompressedTranscripts && entry.name.endsWith(".jsonl.zst")
						? entry.name.slice(0, -4)
						: entry.name;
				if (entry.isDirectory()) directories.push(path);
				else if (
					entry.isFile() &&
					(transcriptName.endsWith(`${sessionId}.jsonl`) ||
						(transcriptName.includes(`${sessionId}_`) && transcriptName.endsWith(".jsonl")))
				)
					paths.push(path);
			}
		} catch {
			/* 无法读取的目录不构成任何会话存在的证据。 */
		}
	}
	const selected = new Map<string, string>();
	for (const path of paths.sort()) {
		const ordinaryPath = codexTranscriptJsonlPath(path);
		if (!selected.has(ordinaryPath)) selected.set(ordinaryPath, path);
	}
	return [...selected.values()];
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
	let threadSourceIsUser = true;
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
						threadSourceIsUser = true;
					}
				} else if (depth === 2 && readingPayloadObject) {
					payloadKey = capturedText;
					if (payloadKey === "id") metadataIdMatches = false;
					if (payloadKey === "session_id") optionalSessionIdMatches = false;
					if (payloadKey === "thread_source") threadSourceIsUser = false;
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
						: depth === 2 &&
								readingPayloadObject &&
								["id", "session_id", "source", "thread_source"].includes(payloadKey)
							? payloadKey
							: "";
			} else if (token.name === "endString") {
				if (capturedStringField === "type") recordTypeMatches = capturedText === "session_meta";
				if (capturedStringField === "id") metadataIdMatches = capturedText === nativeSessionId;
				if (capturedStringField === "session_id") optionalSessionIdMatches = capturedText === nativeSessionId;
				if (capturedStringField === "thread_source") threadSourceIsUser = capturedText === "user";
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
			recordTypeMatches &&
			metadataIdMatches &&
			optionalSessionIdMatches &&
			sourceIsPersistentMainConversation &&
			threadSourceIsUser,
	};
}

async function transcriptEstablishesRequestedCodexConversation(
	path: string,
	nativeSessionId: string,
): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		let transcriptFileChunks: AsyncGenerator<Uint8Array, void, unknown> | null = null;
		try {
			const file = await handle.stat();
			if (!file.isFile()) return false;
			const transcriptInspectionDeadline = performance.now() + 3_000;
			const transcriptInspectionAbortSignal = AbortSignal.timeout(3_000);
			let foundMetadataLineTerminator = false;
			const metadataLineComplete = new Error("Codex 元数据首行读取完成");
			const transcriptIsZstandardCompressed = path.endsWith(".jsonl.zst");
			const assertWithinInspectionDeadline = () => {
				if (performance.now() >= transcriptInspectionDeadline) throw new Error("Codex 元数据预检超时");
			};
			const forwardMetadataLineChunk = (chunk: Uint8Array) => {
				assertWithinInspectionDeadline();
				if (foundMetadataLineTerminator) return;
				const newline = chunk.indexOf(10);
				metadataLineStream.push(Buffer.from(chunk.subarray(0, newline < 0 ? chunk.length : newline)));
				if (newline >= 0) {
					foundMetadataLineTerminator = true;
					if (!transcriptIsZstandardCompressed) throw metadataLineComplete;
				}
			};
			const metadataLineStream = new Transform({
				transform(chunk: Uint8Array, _encoding, callback) {
					try {
						forwardMetadataLineChunk(chunk);
						callback();
					} catch (error) {
						callback(error === metadataLineComplete ? null : (error as Error));
					}
				},
			});
			const identityInspector = createCodexMetadataIdentityTokenInspector(nativeSessionId);
			const decodedChunks = readCodexDecodedTranscriptChunks(
				handle,
				path,
				file.size,
				assertWithinInspectionDeadline,
				transcriptInspectionAbortSignal,
			);
			transcriptFileChunks = decodedChunks;
			async function* readDecodedTranscriptChunks() {
				for await (const chunk of decodedChunks) {
					yield chunk;
					// 压缩首行之后仍读到正常 EOF，保持原完整性与 3 秒预检门禁。
					if (foundMetadataLineTerminator && !transcriptIsZstandardCompressed) return;
				}
			}
			await pipeline(
				Readable.from(readDecodedTranscriptChunks()),
				metadataLineStream,
				streamJson.parser({ packValues: false }),
				// 同步消费 token，避免单块压缩数据展开后积压大体积元数据字符串。
				new Writable({
					objectMode: true,
					write(token, _encoding, callback) {
						try {
							assertWithinInspectionDeadline();
							identityInspector.inspect(token);
							callback();
						} catch (error) {
							callback(error as Error);
						}
					},
				}),
			);
			return foundMetadataLineTerminator && identityInspector.matches();
		} finally {
			await transcriptFileChunks?.return();
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
	const inspectedFileVersions = new Set<string>();
	const inspectCandidate = async (path: string): Promise<boolean> => {
		if (!isWithinEffectiveCodexStore(path)) return false;
		try {
			await assertCodexTranscriptNativeStoragePathOwnership(path);
			const before = await stat(path);
			const version = `${path}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
			if (inspectedFileVersions.has(version)) return false;
			inspectedFileVersions.add(version);
			if (!(await transcriptEstablishesRequestedCodexConversation(path, input.nativeSessionId))) return false;
			const after = await stat(path);
			return before.dev === after.dev && before.ino === after.ino;
		} catch {
			return false;
		}
	};
	const savedPath = input.transcriptPath;
	const savedPathCounterpart = savedPath?.endsWith(".jsonl")
		? `${savedPath}.zst`
		: savedPath?.endsWith(".jsonl.zst")
			? savedPath.slice(0, -4)
			: null;
	// 压缩与原生解压可能换掉文件名或 inode；只重查一次，且不重复读取未变化的无效文件。
	for (let attempt = 0; attempt < 2; attempt += 1) {
		for (const path of [savedPath, savedPathCounterpart]) {
			if (path && (await inspectCandidate(path)))
				return { persistedTranscriptPath: path, codexSessionsDirectoryPath: root };
		}
		for (const path of await listKnownCodexTranscriptSegmentPaths(root, input.nativeSessionId, {
			includeCompressedTranscripts: true,
		})) {
			if (await inspectCandidate(path)) return { persistedTranscriptPath: path, codexSessionsDirectoryPath: root };
		}
	}
	return { persistedTranscriptPath: null, codexSessionsDirectoryPath: root };
}
