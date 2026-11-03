import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { threadId } from "node:worker_threads";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";

const executeFile = promisify(execFile);
const ownerSchema = z.object({
	schemaVersion: z.literal(1),
	controllerOperationId: z.string().uuid(),
	controllerProcessId: z.number().int().positive(),
	controllerProcessStartTimeText: z.string().min(1),
	sourceInstallationStatePath: z.string(),
	startedAtMs: z.number(),
	controllerThreadId: z.number().int().nonnegative().optional(),
});
let currentControllerProcessStartTime: Promise<string> | undefined;
const activeControllerOperations = new Set<string>();
async function processStartTime(pid: number, environment: NodeJS.ProcessEnv) {
	try {
		const { stdout } = await executeFile("ps", ["-p", String(pid), "-o", "lstart="], {
			env: { ...environment, LC_ALL: "C" },
			timeout: 5_000,
			maxBuffer: 4096,
		});
		return stdout.trim() || null;
	} catch (error) {
		if ((error as { code?: number }).code === 1) return null;
		throw new Error("Codex 插件安装控制器的进程代际暂不可核验，保持机器等待。");
	}
}

export async function claimCodexSourcePluginInstallationControllerOwnership(input: {
	coordinationDirectoryPath: string;
	sourceInstallationStatePath: string;
	environment: NodeJS.ProcessEnv;
	assertPreviousNativeOperationHasExited: (sourceInstallationStatePath: string) => Promise<void>;
}) {
	const ownerPath = join(input.coordinationDirectoryPath, "source-installation-controller-owner.json");
	let previous: z.infer<typeof ownerSchema> | undefined;
	try {
		if (!(await lstat(ownerPath)).isFile()) throw new Error("Codex 来源域控制器记录不是普通文件。");
		previous = ownerSchema.parse(JSON.parse(await readFile(ownerPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (previous) {
		if (
			dirname(previous.sourceInstallationStatePath) !== input.coordinationDirectoryPath ||
			!/^source-installation-[a-f0-9]{64}\.json$/.test(
				previous.sourceInstallationStatePath.slice(input.coordinationDirectoryPath.length + 1),
			)
		)
			throw new Error("Codex 来源域控制器指向了未绑定的安装记录。");
		const completionPath = join(
			input.coordinationDirectoryPath,
			`source-controller-completion-${previous.controllerOperationId}.json`,
		);
		let completed = false;
		try {
			if (!(await lstat(completionPath)).isFile()) throw new Error("Codex 来源域控制器回执不是普通文件。");
			const completion = ownerSchema
				.extend({ completedAtMs: z.number() })
				.parse(JSON.parse(await readFile(completionPath, "utf8")));
			completed =
				completion.controllerOperationId === previous.controllerOperationId &&
				completion.controllerProcessId === previous.controllerProcessId &&
				completion.controllerProcessStartTimeText === previous.controllerProcessStartTimeText;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const sameLocalControllerThread =
			previous.controllerProcessId === process.pid && previous.controllerThreadId === threadId;
		if (
			!completed &&
			!(sameLocalControllerThread && !activeControllerOperations.has(previous.controllerOperationId)) &&
			(await processStartTime(previous.controllerProcessId, input.environment)) ===
				previous.controllerProcessStartTimeText
		)
			throw new Error("同一物理来源域的插件安装控制器仍在执行，等待其完成后自动接续。");
		// 控制器退出不证明它的原生子进程退出；跨 profile 也检查前一个完整来源的尝试。
		await input.assertPreviousNativeOperationHasExited(previous.sourceInstallationStatePath);
	}
	currentControllerProcessStartTime ??= processStartTime(process.pid, input.environment)
		.then((value) => {
			if (!value) throw new Error("当前 Codex 来源域控制器的进程代际暂不可核验。");
			return value;
		})
		.catch((error) => {
			currentControllerProcessStartTime = undefined;
			throw error;
		});
	const owner = ownerSchema.parse({
		schemaVersion: 1,
		controllerOperationId: randomUUID(),
		controllerProcessId: process.pid,
		controllerThreadId: threadId,
		controllerProcessStartTimeText: await currentControllerProcessStartTime,
		sourceInstallationStatePath: input.sourceInstallationStatePath,
		startedAtMs: Date.now(),
	});
	await lockedFileSystem.writeTextFileAtomic(ownerPath, JSON.stringify(owner), {
		lock: null,
		durable: true,
		fileMode: 0o600,
	});
	activeControllerOperations.add(owner.controllerOperationId);
	return async () => {
		try {
			await lockedFileSystem.writeTextFileAtomic(
				join(input.coordinationDirectoryPath, `source-controller-completion-${owner.controllerOperationId}.json`),
				JSON.stringify({ ...owner, completedAtMs: Date.now() }),
				{ lock: null, durable: true, fileMode: 0o600 },
			);
		} finally {
			activeControllerOperations.delete(owner.controllerOperationId);
		}
	};
}
