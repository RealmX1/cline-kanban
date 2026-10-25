import { type ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { lockedFileSystem } from "../fs/locked-file-system";
import { TaskMainSessionHandoverExecutionProhibitedError } from "./codex-main-session-handover-native-fork";

const childIdentitySchema = z.object({ nativeSessionId: z.string().min(1), transcriptPath: z.string().min(1) });
const transcriptForkReceiptSchema = z.object({
	handoverId: z.string(),
	sourceAgentId: z.enum(["claude", "omp"]),
	sourceNativeSessionId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	workingDirectoryPath: z.string(),
	sourceTranscriptPath: z.string(),
	frozenTranscriptPath: z.string(),
	frozenTranscriptSha256: z.string(),
	sourceLastMessageId: z.string().optional(),
	frozenOmpArtifactFilesSha256: z.record(z.string(), z.string()).optional(),
	attempts: z.array(
		z.object({
			startedAt: z.number(),
			childIdentity: childIdentitySchema.nullable(),
			verifiedAt: z.number().nullable(),
		}),
	),
});
type TranscriptForkReceipt = z.infer<typeof transcriptForkReceiptSchema>;
interface TranscriptForkInput {
	handoverId: string;
	sourceTaskConversationSessionId: string;
	sourceAgentId: "claude" | "omp";
	sourceNativeSessionId: string;
	sourceTranscriptPath: string;
	workingDirectoryPath: string;
	receiptFilePath: string;
	frozenReceiptFilePath?: string;
	sourceTranscriptSnapshotPath?: string;
}
export interface TaskMainSessionHandoverTranscriptNativeForkPort {
	createIndependentFork(
		input: Omit<TranscriptForkReceipt, "attempts"> & { childIdentityReceiptFilePath: string },
	): Promise<z.infer<typeof childIdentitySchema>>;
}
const executeFile = promisify(execFile);

async function readOmpArtifactFilesSha256(transcriptPath: string): Promise<Record<string, string>> {
	const artifactDirectoryPath = transcriptPath.replace(/\.jsonl$/u, "");
	if (artifactDirectoryPath === transcriptPath) return {};
	let paths: string[];
	try {
		paths = await readdir(artifactDirectoryPath, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const files: Record<string, string> = {};
	for (const path of paths.sort()) {
		const filePath = join(artifactDirectoryPath, path);
		if ((await stat(filePath)).isFile())
			files[path] = createHash("sha256")
				.update(await readFile(filePath))
				.digest("hex");
	}
	return files;
}

function readRecords(text: string) {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const record = parseTranscriptJsonRecord(line);
			if (!record)
				throw new TaskMainSessionHandoverExecutionProhibitedError("原生固定历史含不完整记录，未创建分支。");
			return record;
		});
}

function comparableHistory(text: string, agentId: "claude" | "omp") {
	return readRecords(text)
		.filter((record) =>
			agentId === "omp"
				? !["session", "title"].includes(String(record.type))
				: ["user", "assistant", "system", "message"].includes(String(record.type)) && record.isSidechain !== true,
		)
		.map((record) => {
			const comparable = { ...record };
			for (const key of [
				"id",
				"uuid",
				"parentId",
				"parentUuid",
				"sessionId",
				"timestamp",
				"cwd",
				"version",
				"isSidechain",
				"requestId",
				"forkedFrom",
			])
				delete comparable[key];
			const message = readTranscriptRecord(comparable.message);
			if (message) {
				const content = { ...message };
				for (const key of ["id", "usage", "model", "timestamp"]) delete content[key];
				comparable.message = content;
			}
			return JSON.stringify(comparable);
		});
}

export async function createIndependentTaskMainSessionHandoverTranscriptFork(
	input: Parameters<TaskMainSessionHandoverTranscriptNativeForkPort["createIndependentFork"]>[0],
	onPreparationChildSpawned?: (child: ChildProcess) => void,
) {
	if (input.sourceAgentId === "claude") {
		if (!input.sourceLastMessageId)
			throw new TaskMainSessionHandoverExecutionProhibitedError(
				"Claude 固定来源缺少最后消息 UUID，未按最新历史猜测。",
			);
		const forked = await forkSession(input.sourceNativeSessionId, {
			dir: input.workingDirectoryPath,
			upToMessageId: input.sourceLastMessageId,
			title: "Kanban 主会话交接",
		});
		const child = {
			nativeSessionId: forked.sessionId,
			transcriptPath: join(dirname(input.sourceTranscriptPath), `${forked.sessionId}.jsonl`),
		};
		await lockedFileSystem.writeJsonFileAtomic(input.childIdentityReceiptFilePath, child, { durable: true });
		return child;
	}
	const extensionPath = `${input.childIdentityReceiptFilePath}.native-preparation.mjs`;
	// 复用 OMP 的原生 --fork 文件入口；只落盘身份和 Plan 状态，不提交模型输入。
	await lockedFileSystem.writeTextFileAtomic(
		extensionPath,
		`import { open, rename } from "node:fs/promises";
export default function registerHandoverNativePreparation(api) {
 api.on("session_start", async (_event, context) => {
  try {
   const manager = context.sessionManager;
   if (manager.getSessionId() === ${JSON.stringify(input.sourceNativeSessionId)}) throw new Error("原生 fork 没有独立身份");
   manager.appendModeChange("plan"); await manager.flush();
   const path = ${JSON.stringify(input.childIdentityReceiptFilePath)};
   const handle = await open(path + ".writing", "w", 0o600);
   try { await handle.writeFile(JSON.stringify({ nativeSessionId: manager.getSessionId(), transcriptPath: manager.getSessionFile() })); await handle.sync(); } finally { await handle.close(); }
   await rename(path + ".writing", path);
   process.exit(0);
  } catch (error) { process.stderr.write(String(error)); process.exit(1); }
 });
}
`,
		{ durable: true },
	);
	const preparationEnvironment: NodeJS.ProcessEnv = { ...process.env, OMP_SKIP_SETUP: "1" };
	for (const name of Object.keys(preparationEnvironment))
		if (name.startsWith("KANBAN_")) delete preparationEnvironment[name];
	const preparation = executeFile(
		"omp",
		["--mode", "rpc", "--fork", input.frozenTranscriptPath, "--extension", extensionPath],
		{ cwd: input.workingDirectoryPath, env: preparationEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 },
	);
	onPreparationChildSpawned?.(preparation.child);
	await preparation;
	return childIdentitySchema.parse(JSON.parse(await readFile(input.childIdentityReceiptFilePath, "utf8")));
}

export async function prepareTaskMainSessionHandoverTranscriptNativeFork(
	input: TranscriptForkInput,
	port: TaskMainSessionHandoverTranscriptNativeForkPort = {
		createIndependentFork: createIndependentTaskMainSessionHandoverTranscriptFork,
	},
) {
	return await lockedFileSystem.withLock({ path: input.receiptFilePath }, async () => {
		let receipt: TranscriptForkReceipt;
		try {
			receipt = transcriptForkReceiptSchema.parse(JSON.parse(await readFile(input.receiptFilePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (input.frozenReceiptFilePath) {
				const frozen = transcriptForkReceiptSchema.parse(
					JSON.parse(await readFile(input.frozenReceiptFilePath, "utf8")),
				);
				receipt = { ...frozen, attempts: [] };
			} else {
				const text = await readFile(input.sourceTranscriptSnapshotPath ?? input.sourceTranscriptPath, "utf8");
				const records = readRecords(text);
				if (
					!records.length ||
					records.some(
						(record) => typeof record.sessionId === "string" && record.sessionId !== input.sourceNativeSessionId,
					) ||
					records.some((record) => record.type === "session" && record.id !== input.sourceNativeSessionId)
				)
					throw new TaskMainSessionHandoverExecutionProhibitedError("固定来源原生身份不符。");
				const frozenTranscriptPath = `${input.receiptFilePath}.source-snapshot.jsonl`;
				await lockedFileSystem.writeTextFileAtomic(frozenTranscriptPath, text, { durable: true });
				let frozenOmpArtifactFilesSha256: Record<string, string> | undefined;
				if (input.sourceAgentId === "omp") {
					const originalPath = await realpath(input.sourceTranscriptPath);
					const originalArtifacts = originalPath.replace(/\.jsonl$/u, "");
					try {
						if (originalArtifacts !== originalPath)
							await cp(originalArtifacts, frozenTranscriptPath.slice(0, -6), {
								recursive: true,
								dereference: true,
							});
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					frozenOmpArtifactFilesSha256 = await readOmpArtifactFilesSha256(frozenTranscriptPath);
					if (
						JSON.stringify(frozenOmpArtifactFilesSha256) !==
						JSON.stringify(await readOmpArtifactFilesSha256(originalPath))
					)
						throw new TaskMainSessionHandoverExecutionProhibitedError("OMP 原生附件在冻结期间改变，未创建分支。");
				}
				receipt = {
					handoverId: input.handoverId,
					sourceAgentId: input.sourceAgentId,
					sourceNativeSessionId: input.sourceNativeSessionId,
					sourceTaskConversationSessionId: input.sourceTaskConversationSessionId,
					workingDirectoryPath: resolve(input.workingDirectoryPath),
					sourceTranscriptPath: input.sourceTranscriptPath,
					frozenTranscriptPath,
					frozenTranscriptSha256: createHash("sha256").update(text).digest("hex"),
					frozenOmpArtifactFilesSha256,
					sourceLastMessageId: records.filter((record) => typeof record.uuid === "string").at(-1)?.uuid as
						| string
						| undefined,
					attempts: [],
				};
			}
		}
		if (
			receipt.handoverId !== input.handoverId ||
			receipt.sourceAgentId !== input.sourceAgentId ||
			receipt.workingDirectoryPath !== resolve(input.workingDirectoryPath) ||
			(!input.frozenReceiptFilePath && receipt.sourceNativeSessionId !== input.sourceNativeSessionId)
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("原生准备凭据与来源身份或目录归属不符。");
		const frozenText = await readFile(receipt.frozenTranscriptPath, "utf8");
		if (createHash("sha256").update(frozenText).digest("hex") !== receipt.frozenTranscriptSha256)
			throw new TaskMainSessionHandoverExecutionProhibitedError("固定来源快照已改变，保留失败历史。");
		if (
			receipt.frozenOmpArtifactFilesSha256 &&
			JSON.stringify(await readOmpArtifactFilesSha256(receipt.frozenTranscriptPath)) !==
				JSON.stringify(receipt.frozenOmpArtifactFilesSha256)
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("固定原生附件已改变，保留失败历史。");
		if (
			!input.frozenReceiptFilePath &&
			createHash("sha256")
				.update(await readFile(input.sourceTranscriptPath))
				.digest("hex") !== receipt.frozenTranscriptSha256
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("来源历史边界已改变，未采用陈旧交接。");
		const persist = async () =>
			await lockedFileSystem.writeJsonFileAtomic(input.receiptFilePath, receipt, { lock: null, durable: true });
		// 准备进程可能已落盘子身份，但宿主尚未写回主凭据便重启；先补证所有已登记尝试。
		for (const [index, candidate] of receipt.attempts.entries()) {
			if (candidate.childIdentity) continue;
			try {
				candidate.childIdentity = childIdentitySchema.parse(
					JSON.parse(await readFile(`${input.receiptFilePath}.attempt-${index + 1}.child-identity.json`, "utf8")),
				);
				await persist();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		let attempt = receipt.attempts.find((candidate) => candidate.childIdentity) ?? receipt.attempts.at(-1);
		if (!attempt?.childIdentity) {
			if (receipt.attempts.length >= 3 || (attempt && Date.now() - attempt.startedAt < 15_000))
				throw new Error("原生准备等待有界重验条件，不启动模型。");
			attempt = { startedAt: Date.now(), childIdentity: null, verifiedAt: null };
			receipt.attempts.push(attempt);
			await persist();
			attempt.childIdentity = await port.createIndependentFork({
				...receipt,
				childIdentityReceiptFilePath: `${input.receiptFilePath}.attempt-${receipt.attempts.length}.child-identity.json`,
			});
			await persist();
		}
		const child = attempt.childIdentity;
		if (
			!child ||
			child.nativeSessionId === receipt.sourceNativeSessionId ||
			child.nativeSessionId === input.sourceNativeSessionId
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("原生分支没有独立身份。");
		const original = comparableHistory(frozenText, receipt.sourceAgentId);
		const childText = await readFile(child.transcriptPath, "utf8");
		const expectedDirectory = await realpath(receipt.workingDirectoryPath);
		for (const record of readRecords(childText)) {
			if (
				(typeof record.sessionId === "string" && record.sessionId !== child.nativeSessionId) ||
				(record.type === "session" && record.id !== child.nativeSessionId)
			)
				throw new TaskMainSessionHandoverExecutionProhibitedError("子会话原生身份与准备凭据不符。");
			if (typeof record.cwd === "string" && (await realpath(record.cwd)) !== expectedDirectory)
				throw new TaskMainSessionHandoverExecutionProhibitedError("子会话工作目录与固定归属不符。");
		}
		const actual = comparableHistory(childText, receipt.sourceAgentId);
		if (!original.length || original.some((record, index) => actual[index] !== record))
			throw new Error("子会话尚未完整保留固定历史，保留独立身份等待复验。");
		if (receipt.frozenOmpArtifactFilesSha256) {
			const inheritedArtifacts = await readOmpArtifactFilesSha256(child.transcriptPath);
			if (
				Object.entries(receipt.frozenOmpArtifactFilesSha256).some(
					([path, sha256]) => inheritedArtifacts[path] !== sha256,
				)
			)
				throw new Error("子会话尚未完整保留原生附件，保留独立身份等待复验。");
		}
		if (
			!input.frozenReceiptFilePath &&
			createHash("sha256")
				.update(await readFile(input.sourceTranscriptPath))
				.digest("hex") !== receipt.frozenTranscriptSha256
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("来源历史在准备期间已改变，未切换主会话。");
		if (
			!input.frozenReceiptFilePath &&
			receipt.frozenOmpArtifactFilesSha256 &&
			JSON.stringify(await readOmpArtifactFilesSha256(await realpath(input.sourceTranscriptPath))) !==
				JSON.stringify(receipt.frozenOmpArtifactFilesSha256)
		)
			throw new TaskMainSessionHandoverExecutionProhibitedError("来源原生附件在准备期间已改变，未切换主会话。");
		attempt.verifiedAt = Date.now();
		await persist();
		return { ...child, sourceCompletedTurnCount: null, codexConversationStorageHomeDirectoryPath: undefined };
	});
}
