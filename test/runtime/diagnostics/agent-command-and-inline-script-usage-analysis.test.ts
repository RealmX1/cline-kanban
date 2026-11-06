import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const verificationScript = fileURLToPath(
	new URL("../../fixtures/agent-command-usage-analysis/verify_agent_command_usage_analysis.py", import.meta.url),
);

describe("命令与内联脚本的离线分析", { timeout: 90_000 }, () => {
	it.each([
		["ManifestAndReplayTests", "固定输入、去重冲突、子集覆盖及重放恢复"],
		["ParserAndGoalEvidenceTests", "静态解析、目标证据、完整成本与公开导出隐私"],
		["ControlledGoalRecipeTests", "完整快照与Unicode证据读取的受控语义对照"],
		["DiscoveryAndBoundaryTests", "仓内入口、目录冻结、写入归属与未知覆盖"],
	])("%s：%s", (verificationClass) => {
		const isolatedHome = mkdtempSync(join(tmpdir(), "agent-command-analysis-home-"));
		try {
			const result = spawnSync("python3", ["-B", verificationScript, verificationClass], {
				encoding: "utf8",
				timeout: 60_000,
				killSignal: "SIGKILL",
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					HOME: isolatedHome,
					USERPROFILE: isolatedHome,
					CODEX_HOME: join(isolatedHome, "codex-configuration"),
					CODEX_SQLITE_HOME: join(isolatedHome, "codex-storage"),
					TMPDIR: isolatedHome,
					TEMP: isolatedHome,
					PYTHONUTF8: "1",
				},
			});
			expect(result.error).toBeUndefined();
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		} finally {
			rmSync(isolatedHome, { recursive: true, force: true });
		}
	});
});
