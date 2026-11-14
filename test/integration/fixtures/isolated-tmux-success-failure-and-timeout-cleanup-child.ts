import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createIsolatedTestOwnedTmuxServer } from "../../utilities/isolated-test-owned-tmux-server";

const outcome = process.argv[2];
assert(["success", "failure", "timeout"].includes(outcome));
const server = createIsolatedTestOwnedTmuxServer(process.env);
try {
	assert.equal(server.environment.TMUX, undefined);
	assert.equal(server.environment.TMUX_PANE, undefined);
	const grandchild = spawnSync(
		process.execPath,
		[
			"-e",
			"process.stdout.write(JSON.stringify({TMUX:process.env.TMUX,TMUX_PANE:process.env.TMUX_PANE,TMUX_TMPDIR:process.env.TMUX_TMPDIR}))",
		],
		{
			env: server.environment,
			encoding: "utf8",
		},
	);
	assert.equal(grandchild.status, 0);
	const grandchildEnvironment = JSON.parse(grandchild.stdout) as NodeJS.ProcessEnv;
	assert.equal(grandchildEnvironment.TMUX, undefined);
	assert.equal(grandchildEnvironment.TMUX_PANE, undefined);
	assert.equal(grandchildEnvironment.TMUX_TMPDIR, server.environment.TMUX_TMPDIR);
	// 父测试见到 ready 后 25ms 就发 SIGTERM。处理器必须先装好，否则默认终止会跳过 finally。
	let waitForWatchdogTermination: Promise<void> | undefined;
	if (outcome === "timeout") {
		const timeoutWaitKeepalive = setInterval(() => {}, 1_000);
		waitForWatchdogTermination = new Promise<void>((resolveTerminatedWait) => {
			process.once("SIGTERM", () => {
				clearInterval(timeoutWaitKeepalive);
				process.stderr.write("watchdog 超时，开始清理自有 tmux 会话\n");
				process.exitCode = 143;
				resolveTerminatedWait();
			});
		});
	}
	process.stdout.write(`${JSON.stringify({ socketPath: server.socketPath })}\n`);
	if (outcome === "failure") throw new Error("预期的业务失败");
	if (waitForWatchdogTermination) await waitForWatchdogTermination;
} catch (error) {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 17;
} finally {
	server.cleanup();
	server.cleanup();
	process.stdout.write("已完成自有会话清理\n");
}
