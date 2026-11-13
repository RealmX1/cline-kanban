import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it.each([false, true])("根命令变化=%s 时仍追踪所属后代并在撤销时终止", async (rootCommandChanges) => {
	const directory = await mkdtemp(join(tmpdir(), "owned-orphan-supervisor-"));
	try {
		const sourceFile = await readFile(
			join(process.cwd(), "src/task-command-execution/task-command-execution-supervisor.ts"),
			"utf8",
		);
		const source = sourceFile.split("const supervisorSource = String.raw`")[1]?.split("`;\n")[0];
		if (!source) throw new Error("未找到监督进程真实入口");
		const materialsFile = join(directory, "materials.json");
		const revocationFile = join(directory, "revocation.json");
		await writeFile(
			materialsFile,
			JSON.stringify({
				directory,
				launchNonce: "nonce",
				executionId: "execution",
				revocationFile,
				command: ["isolated-command"],
				workingDirectory: directory,
			}),
		);
		const processes = new Map([
			[900, { parent: 1, startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor" }],
			[201, { parent: 900, startAndCommand: "Wed Oct 28 12:00:00 2026 root-command" }],
			[301, { parent: 201, startAndCommand: "Wed Oct 28 12:00:00 2026 owned-descendant" }],
		]);
		const child = Object.assign(new EventEmitter(), { pid: 201 });
		const signals: number[] = [];
		let cycle = 0;
		await runInNewContext(
			`(async () => {${source.replace(/^import .*;\n/gm, "")} })()`,
			{
				open,
				readFile,
				rename,
				mkdir,
				unlink,
				join,
				spawn: () => child,
				execFileSync: (_command: string, arguments_: string[]) => {
					if (arguments_[0] === "-axo")
						return [...processes]
							.map(([pid, entry]) => `${pid} ${entry.parent} S ${entry.startAndCommand}`)
							.join("\n");
					const entry = processes.get(Number(arguments_[1]));
					if (!entry) throw Object.assign(new Error("已退出"), { status: 1 });
					return entry.startAndCommand;
				},
				process: {
					pid: 900,
					argv: ["node", "supervisor.mjs", materialsFile],
					env: {},
					on: () => undefined,
					kill: (pid: number) => {
						signals.push(pid);
						processes.delete(pid);
						if (pid === 201) child.emit("exit", null, "SIGTERM");
					},
				},
				setTimeout: (callback: () => void) => {
					cycle++;
					if (cycle === 1) {
						if (rootCommandChanges) {
							const root = processes.get(201);
							if (root) root.startAndCommand = "Wed Oct 28 12:00:00 2026 execed-worker";
						} else {
							processes.delete(201);
							child.emit("exit", 0);
						}
						const orphan = processes.get(301);
						if (orphan && !rootCommandChanges) orphan.parent = 1;
					} else if (cycle === 2) {
						processes.set(401, { parent: 301, startAndCommand: "Wed Oct 28 12:00:00 2026 later-grandchild" });
					} else if (cycle === 3) {
						writeFileSync(revocationFile, "revoked");
					} else if (cycle > 8) throw new Error("监督循环未能有界退出");
					queueMicrotask(callback);
				},
			},
			{ timeout: 1000 },
		);
		if (rootCommandChanges) expect(signals).toContain(201);
		expect(signals).toContain(301);
		expect(signals).toContain(401);
		expect(processes.has(401)).toBe(false);
		const progress = JSON.parse(await readFile(join(directory, "supervisor-progress-nonce.json"), "utf8"));
		expect(progress.status).toBe("cancelled");
		expect(progress.ownedProcesses.map((entry: { pid: number }) => entry.pid)).toEqual(
			expect.arrayContaining([301, 401]),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
