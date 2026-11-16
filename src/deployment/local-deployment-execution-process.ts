import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { LocalDeploymentCommandRunner } from "./local-deployment-execution";

// 原文完整落盘；超出核验预算的正文保留未知，不截取片段冒充 JSON。
const MAXIMUM_EFFECT_VERIFICATION_JSON_BYTES = 1_048_576;

export const runLocalDeploymentCommandPreservingOriginalOutput: LocalDeploymentCommandRunner = async (
	command,
	context,
) => {
	const stdoutPath = join(context.commandOutputDirectory, "stdout.txt");
	const stderrPath = join(context.commandOutputDirectory, "stderr.txt");
	let stdout: FileHandle | undefined;
	let stderr: FileHandle | undefined;
	try {
		try {
			stdout = await open(stdoutPath, "wx", 0o600);
			stderr = await open(stderrPath, "wx", 0o600);
		} catch (error) {
			// 输出文件尚未打开，spawn 没有执行。调用方据此记 command_not_started，而不是未知副作用。
			return { exitCode: null, processWasStarted: false, stdout: "", stderr: String(error) };
		}
		const startedAtEpochMs = Date.now();
		const result = await new Promise<{
			exitCode: number | null;
			signal: NodeJS.Signals | null;
			processId: number | null;
			processWasStarted: boolean;
			spawnError?: string;
		}>((resolveResult) => {
			let child: ReturnType<typeof spawn>;
			try {
				context.assertCommandMayStart();
				child = spawn(command[0], command.slice(1), {
					cwd: context.cwd,
					env: {
						...process.env,
						KANBAN_LOCAL_DEPLOYMENT_EXECUTION_ID: context.executionId,
						KANBAN_LOCAL_DEPLOYMENT_STAGE: context.stage,
						KANBAN_LOCAL_DEPLOYMENT_STAGE_ATTEMPT_NUMBER: String(context.attemptNumber),
					},
					stdio: ["ignore", stdout?.fd, stderr?.fd ?? "ignore"],
				});
			} catch (error) {
				resolveResult({
					exitCode: null,
					signal: null,
					processId: null,
					processWasStarted: false,
					spawnError: String(error),
				});
				return;
			}
			let spawnError: string | undefined;
			child.once("error", (error) => {
				spawnError = String(error);
			});
			child.once("close", (exitCode, signal) =>
				resolveResult({
					exitCode,
					signal,
					processId: child.pid ?? null,
					processWasStarted: child.pid !== undefined,
					spawnError,
				}),
			);
		});
		let originalPersistError: string | undefined;
		try {
			await Promise.all([stdout.sync(), stderr.sync()]);
			await lockedFileSystem.writeJsonFileAtomic(
				join(context.commandOutputDirectory, "command-result.json"),
				{
					...result,
					command,
					cwd: context.cwd,
					attemptIdentity: {
						executionId: context.executionId,
						stage: context.stage,
						attemptNumber: context.attemptNumber,
						commandOutputDirectory: context.commandOutputDirectory,
					},
					startedAtEpochMs,
					finishedAtEpochMs: Date.now(),
				},
				{ lock: null, durable: true, fileMode: 0o600 },
			);
		} catch (error) {
			// 原件同步失败不能抹掉已经确认的启动事实；未启动则仍然返回 false，便于有界重试。
			originalPersistError = String(error);
		}
		let stdoutText = "";
		let stderrText = "";
		try {
			stdoutText =
				(await stat(stdoutPath)).size <= MAXIMUM_EFFECT_VERIFICATION_JSON_BYTES
					? await readFile(stdoutPath, "utf8")
					: "";
			stderrText =
				(await stat(stderrPath)).size <= MAXIMUM_EFFECT_VERIFICATION_JSON_BYTES
					? await readFile(stderrPath, "utf8")
					: "错误输出超过核验预算，原文已完整保存";
		} catch (error) {
			originalPersistError ??= String(error);
		}
		return {
			exitCode: result.exitCode,
			processWasStarted: result.processWasStarted,
			stdout: stdoutText,
			stderr: result.spawnError ?? originalPersistError ?? stderrText,
		};
	} finally {
		// 关闭失败也不能把已知的 spawn 结果改写为未知副作用。
		await Promise.allSettled([stdout?.close(), stderr?.close()]);
	}
};
