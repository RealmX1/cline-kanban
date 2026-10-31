import { spawn } from "node:child_process";

const UNAVAILABLE_OBSERVATION = "read_only_observation_unavailable";

/** 只读采样仍要收口子进程：取消、超时或输出超预算不能遗留下一轮之外的观察者。 */
export async function readOnlyTaskCommandExecutionRecoveryEvidenceObservation(input: {
	command: readonly string[];
	workingDirectory: string;
	signal: AbortSignal;
}): Promise<string> {
	const observationExecutable = input.command[0];
	if (!observationExecutable || input.signal.aborted) return UNAVAILABLE_OBSERVATION;
	return await new Promise<string>((resolveObservation) => {
		let child: ReturnType<typeof spawn> | undefined;
		let settled = false;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		const finish = (observation: string) => {
			if (settled) return;
			settled = true;
			if (deadline) clearTimeout(deadline);
			input.signal.removeEventListener("abort", abort);
			child?.kill("SIGKILL");
			if (child?.pid && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* 独立观察进程组已经退出。 */
				}
			}
			resolveObservation(observation);
		};
		const abort = () => finish(UNAVAILABLE_OBSERVATION);
		try {
			child = spawn(observationExecutable, input.command.slice(1), {
				cwd: input.workingDirectory,
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish(UNAVAILABLE_OBSERVATION);
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > 1_048_576) finish(UNAVAILABLE_OBSERVATION);
			else chunks.push(chunk);
		});
		child.once("error", abort);
		child.once("close", (exitCode) => {
			if (exitCode !== 0) {
				finish(UNAVAILABLE_OBSERVATION);
				return;
			}
			try {
				const observation: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				finish(
					observation &&
						typeof observation === "object" &&
						"evidenceSha256" in observation &&
						typeof observation.evidenceSha256 === "string" &&
						/^[a-f0-9]{64}$/u.test(observation.evidenceSha256)
						? observation.evidenceSha256
						: UNAVAILABLE_OBSERVATION,
				);
			} catch {
				finish(UNAVAILABLE_OBSERVATION);
			}
		});
		input.signal.addEventListener("abort", abort, { once: true });
		deadline = setTimeout(abort, 15_000);
	});
}
