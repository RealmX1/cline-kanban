// 五对交替 AB/BA；失败、退出码及每次 argv 都保留，不挑选成功样本。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
	"baseline-module": { type: "string" }, "candidate-module": { type: "string" },
	"corpus-directory": { type: "string" }, "evidence-directory": { type: "string" },
	comparison: { type: "string", default: "optimizations" },
	"steady-duration-ms": { type: "string", default: "60000" },
	"historical-pause-ms": { type: "string", default: "200" },
	"disable-feature-in-variant-a": { type: "string", default: "none" },
} });
for (const key of ["baseline-module", "corpus-directory", "evidence-directory"])
	if (!values[key]) throw new Error(`缺少 --${key}`);
if (!["optimizations", "recorder"].includes(values.comparison)) throw new Error("comparison 只允许 optimizations 或 recorder");
const evidenceDirectory = resolve(values["evidence-directory"]);
await mkdir(evidenceDirectory, { recursive: false });
const receipts = [];
let activeChild;
let interruptedSignal;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interruptedSignal = signal; activeChild?.kill("SIGTERM"); });
const rollbackEnvironmentVariables = {
	"receipt-ledger-cache": "KANBAN_DAILY_WORK_PROGRESS_RECEIPT_LEDGER_CACHE_DISABLED",
	"receipt-index": "KANBAN_DAILY_WORK_PROGRESS_RECEIPT_INDEX_DISABLED",
	"codex-history-cache": "KANBAN_DAILY_WORK_PROGRESS_CODEX_HISTORY_CACHE_DISABLED",
};
if (values["disable-feature-in-variant-a"] !== "none" && !rollbackEnvironmentVariables[values["disable-feature-in-variant-a"]]) throw new Error("未知的独立回退开关");
let failed = false;
for (let pair = 0; pair < 5; pair++) {
	for (const variant of pair % 2 === 0 ? ["A", "B"] : ["B", "A"]) {
		if (interruptedSignal) break;
		const name = `pair-${pair + 1}-${variant}`;
		const modulePath = resolve(variant === "B" && values.comparison === "optimizations"
			? values["candidate-module"] ?? values["baseline-module"] : values["baseline-module"]);
		const moduleSha256AtStart = createHash("sha256").update(await readFile(modulePath)).digest("hex");
		const args = [modulePath, "--command", "run", "--corpus-directory", resolve(values["corpus-directory"]),
			"--run-directory", join(evidenceDirectory, name), "--steady-duration-ms", values["steady-duration-ms"],
			"--historical-pause-ms", values["historical-pause-ms"],
			"--cost-recording", values.comparison === "recorder" && variant === "A" ? "disabled" : "enabled"];
		const log = createWriteStream(join(evidenceDirectory, `${name}.log`), { flags: "wx" });
		const startedAt = new Date().toISOString();
		const rollbackVariable = variant === "A" ? rollbackEnvironmentVariables[values["disable-feature-in-variant-a"]] : undefined;
		const child = spawn(process.execPath, args, {
			// 不继承真实任务、凭据与控制面环境；HOME 会在隔离 host 启动前绑定。
			env: { PATH: process.env.PATH, HOME: join(evidenceDirectory, name, "bootstrap-home"), NO_COLOR: "1", ...(rollbackVariable ? { [rollbackVariable]: "1" } : {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		activeChild = child;
		let hardDeadlineExceeded = false;
		const hardDeadline = setTimeout(() => { hardDeadlineExceeded = true; child.kill("SIGTERM"); const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000); forceKill.unref(); }, 300_000);
		hardDeadline.unref();
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
		const outcome = await new Promise((resolve) => {
			child.on("error", (error) => resolve({ exitCode: null, error: String(error) }));
			child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
		});
		clearTimeout(hardDeadline);
		activeChild = undefined;
		await new Promise((resolve) => log.end(resolve));
		const moduleSha256AtEnd = createHash("sha256").update(await readFile(modulePath)).digest("hex");
		const moduleChangedDuringRun = moduleSha256AtStart !== moduleSha256AtEnd;
		failed ||= outcome.exitCode !== 0 || moduleChangedDuringRun || hardDeadlineExceeded;
		const receipt = { pair: pair + 1, variant, comparison: values.comparison, rollbackVariable, startedAt, endedAt: new Date().toISOString(),
			executable: process.execPath, args, cwd: process.cwd(), moduleSha256: moduleSha256AtStart, moduleSha256AtEnd, moduleChangedDuringRun, hardDeadlineExceeded, ...outcome };
		receipts.push(receipt);
		await writeFile(join(evidenceDirectory, `${name}-execution.json`), JSON.stringify(receipt, null, 2));
		process.stdout.write(`${name} ${JSON.stringify(outcome)}\n`);
	}
}
await writeFile(join(evidenceDirectory, "executions.json"), JSON.stringify({ options: values, receipts }, null, 2));
process.exitCode = interruptedSignal ? 130 : failed ? 1 : 0;
