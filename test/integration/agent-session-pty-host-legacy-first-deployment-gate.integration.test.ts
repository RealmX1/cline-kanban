import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const execFileAsync = promisify(execFile);
afterEach(async () => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

async function evaluateDeploymentEvidenceProbe(javascript: string) {
	const moduleUrl = pathToFileURL(resolve("scripts/agent-session-pty-host-deployment-evidence.mjs")).href;
	const { stdout } = await execFileAsync(process.execPath, [
		"--input-type=module",
		"--eval",
		`import * as evidence from ${JSON.stringify(moduleUrl)}; ${javascript}`,
	]);
	return JSON.parse(stdout);
}

describe("部署证据的日期与新 runtime 输出边界", () => {
	it("个位数日期的 ps 填充空格不改变同一进程身份", async () => {
		const assessment = await evaluateDeploymentEvidenceProbe(`
const report = { runtimeProcessId: 10, runtimeProcessStartTimeText: "Mon Nov 2 10:00:00 2026", runtimeIdentity: {runtimeHomeDirectoryPath: "/isolated", runtimePort: 3900}, startupDecision: {disabledReason: "persistent_preference_disabled"}, newSessionHostingMode: "disabled", runtimePtySessions: [], nonPtyAgentSessionsPreventingContinuity: [], generations: [] };
console.log(JSON.stringify(evidence.assessAgentSessionPtyHostDeploymentEvidence({ report, processStartTimeByPid: new Map([[10, "Mon Nov  2 10:00:00 2026"]]) })));
`);
		expect(assessment.ok).toBe(true);
	});
	it("重启前已产生的字节和未到达 runtime 的新字节都不能证明重启后输出", async () => {
		const observations = await evaluateDeploymentEvidenceProbe(`
const session = {workspaceId:"workspace", conversationSessionId:"agent", hostedSessionKey:"key", hostedSessionKind:"task_agent_session", nativeConversationSessionId:"native", outputEndByteOffset:100, mostRecentPromptSubmissionId:"old", mostRecentNativePromptAcceptedAtEpochMs:50};
const before = {checkedAtEpochMs:100, validatedHostedSessions:[session]};
const startingPoint = {runtimeProcessId:11, runtimeProcessStartTimeText:"1970-01-01T00:00:00.200Z", checkedAtEpochMs:250, validatedHostedSessions:[{...session, outputEndByteOffset:150, currentRuntimeDeliveredHostedOutputEndByteOffset:150}]};
const current = {...startingPoint, validatedHostedSessions:[{...session, outputEndByteOffset:150, currentRuntimeDeliveredHostedOutputEndByteOffset:150, mostRecentPromptSubmissionId:"new", mostRecentNativePromptAcceptedAtEpochMs:300}]};
const observe = after => evidence.observeHostedSessionIoProgressAfterRuntimeRestart(before, after, startingPoint)[0];
console.log(JSON.stringify({onlyBeforeRestart:observe(current), hostOnly:observe({...current,validatedHostedSessions:[{...current.validatedHostedSessions[0],outputEndByteOffset:151}]}), deliveredAfterRestart:observe({...current,validatedHostedSessions:[{...current.validatedHostedSessions[0],outputEndByteOffset:151,currentRuntimeDeliveredHostedOutputEndByteOffset:151}]})}));
`);
		expect(observations.onlyBeforeRestart).toMatchObject({
			outputProgressObserved: false,
			nativeInputAcceptanceObserved: true,
		});
		expect(observations.hostOnly.outputProgressObserved).toBe(false);
		expect(observations.deliveredAfterRestart.outputProgressObserved).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("旧版首次切换的等价只读门禁", { timeout: 60_000 }, () => {
	it("缺 procedure 时自动补证；迁走项目使用持久记录；活 facet 与未知子进程均阻止切换", async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "kph-legacy-deployment-",
		});
		const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
		await mkdir(join(runtimeHome, "workspaces", "moved-project"), { recursive: true });
		await writeFile(join(runtimeHome, "workspaces", "moved-project", "sessions.json"), "{}");
		const inventoryPath = join(fixture.fixtureRootDirectoryPath, "legacy-api-fixture-inventory.json");
		await writeFile(inventoryPath, JSON.stringify({ sessions: {} }));
		const reservation = createServer();
		await new Promise<void>((resolveListening) => reservation.listen(0, "127.0.0.1", resolveListening));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		const runtimePort = address.port;
		await new Promise<void>((resolveClosed) => reservation.close(() => resolveClosed()));
		const serverPath = join(fixture.fixtureRootDirectoryPath, "cli.js");
		await writeFile(
			serverPath,
			`
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
let child;
const server = createServer((request, response) => {
 const inventory = JSON.parse(readFileSync(process.env.LEGACY_FIXTURE_INVENTORY_PATH, "utf8"));
 if (inventory.spawnChild && !child) child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
 const procedure = request.url.split("/").at(-1);
 let result;
 if (procedure === "runtime.getConfig") result = { globalConfigPath: process.env.LEGACY_FIXTURE_CONFIG_PATH };
 if (procedure === "projects.list") result = { projects: [{ id: "registered-project" }, { id: "moved-project" }] };
 if (procedure === "workspace.getState" && request.headers["x-kanban-workspace-id"] === "registered-project") result = { sessions: inventory.sessions };
 response.setHeader("content-type", "application/json");
 if (result) response.end(JSON.stringify({ result: { data: result } }));
 else { response.statusCode = 404; response.end(JSON.stringify({ error: { data: { code: "NOT_FOUND" } } })); }
});
process.on("SIGTERM", () => { if (child) child.kill("SIGTERM"); server.close(() => process.exit(0)); });
server.listen(Number(process.argv.at(-1)), "127.0.0.1");
`,
		);
		const environment = fixture.createIsolatedChildProcessEnvironment({
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			KANBAN_RUNTIME_PORT: String(runtimePort),
			LEGACY_FIXTURE_CONFIG_PATH: join(runtimeHome, "config.json"),
			LEGACY_FIXTURE_INVENTORY_PATH: inventoryPath,
		});
		const server = children.register(
			spawn(process.execPath, [serverPath, "--port", String(runtimePort)], { env: environment, stdio: "ignore" }),
		);
		const wait = (condition: () => Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: "隔离旧版 API fixture 启动或退出",
					softDeadlineMsExpectedOnUncontendedHost: 2_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10_000,
				},
				condition,
			);
		const runGate = async () => {
			try {
				const { stdout } = await execFileAsync(
					process.execPath,
					[resolve("scripts/verify-agent-session-pty-host-runtime-readiness.mjs"), "--before-runtime-restart"],
					{ env: environment, timeout: 15_000 },
				);
				return { code: 0, report: JSON.parse(stdout) };
			} catch (error) {
				const failure = error as Error & { code: number; stdout: string };
				if (failure.code !== 2) throw error;
				return { code: failure.code, report: JSON.parse(failure.stdout) };
			}
		};
		try {
			await wait(async () => {
				try {
					return (await fetch(`http://127.0.0.1:${runtimePort}/api/trpc/projects.list`)).ok;
				} catch {
					return false;
				}
			});
			const empty = await runGate();
			expect(empty).toMatchObject({
				code: 0,
				report: {
					ok: true,
					evidenceSource: "legacy_api_and_native_quiescence_inventory",
					continuityVerified: false,
					validatedHostedSessions: [],
					projectCountExamined: 2,
				},
			});
			expect(empty.report.projectSessionInventorySources).toContainEqual({
				workspaceId: "moved-project",
				source: "persisted_sessions_and_native_process_inventory",
			});
			await writeFile(
				inventoryPath,
				JSON.stringify({
					sessions: { original: { turnOwner: "agent", liveness: "live", userTurnKind: null, pid: null } },
				}),
			);
			expect(await runGate()).toMatchObject({
				code: 2,
				report: { ok: false, blockingSessions: [expect.objectContaining({ conversationSessionId: "original" })] },
			});
			await writeFile(inventoryPath, JSON.stringify({ sessions: {}, spawnChild: true }));
			expect(await runGate()).toMatchObject({
				code: 2,
				report: {
					ok: false,
					blockingSessions: [expect.objectContaining({ ownership: "legacy_runtime_descendant_unproven" })],
				},
			});
		} finally {
			server.kill("SIGTERM");
			await wait(async () => server.exitCode !== null || server.signalCode !== null);
		}
	});
});
