import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const canonicalRepositoryAgentInstructions = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
const claudeRepositoryAgentInstructions = readFileSync(new URL("../../CLAUDE.md", import.meta.url), "utf8");

describe("RVF 固定候选与最终 base 整合的活跃指令契约", () => {
	it("两个 harness 的活跃入口都不再声明预审吸收", () => {
		for (const instructions of [canonicalRepositoryAgentInstructions, claudeRepositoryAgentInstructions]) {
			expect(instructions).not.toContain("RVF-PRE-REVIEW-BASE-SYNC-SKILL:");
			expect(instructions).not.toContain("先做严格单向同步再准备 RVF");
		}
		expect(claudeRepositoryAgentInstructions).toMatch(/^@AGENTS\.md$/mu);
	});

	it("默认流程将 base 吸收及冲突解决留到最终整合", () => {
		expect(canonicalRepositoryAgentInstructions).toContain(
			"计划 → 实现 → 固定候选 RVF → rvf-land → base-branch-sync",
		);
		expect(canonicalRepositoryAgentInstructions).toMatch(
			/仅在最终 `base-branch-sync` 或未来 GitHub PR 合并阶段吸收 base 并解决冲突/u,
		);
		expect(canonicalRepositoryAgentInstructions).toMatch(
			/开工、计划草拟后、实现完成后与 RVF 准备阶段均不自动吸收 local `main`/u,
		);
	});

	it("计划与实现可只读检查 base 差异并记录交互风险", () => {
		expect(canonicalRepositoryAgentInstructions).toMatch(/计划与实现阶段可只读查看 base 差异、记录交互风险/u);
	});

	it("local main 前移不改变冻结候选的比较 OID", () => {
		expect(canonicalRepositoryAgentInstructions).toMatch(/RVF 冻结本轮候选、HEAD 与比较基线 OID/u);
		expect(canonicalRepositoryAgentInstructions).toMatch(/local `main` 前移不重定向本轮比较 OID/u);
	});

	it("真实候选变化通过既有恢复入口建立新分界并保留旧轮次", () => {
		expect(canonicalRepositoryAgentInstructions).toMatch(/真实 HEAD 或候选变化时拒绝复用旧快照/u);
		expect(canonicalRepositoryAgentInstructions).toMatch(/经既有恢复入口建立新候选和开审分界并保留原轮次记录/u);
	});

	it("保留 PDV 机器入口、收尾 authoring 与 rvf-history 的未知语义", () => {
		expect(canonicalRepositoryAgentInstructions).toMatch(
			/^RVF-ENTRY-SKILL: cline-kanban-post-deploy-verification-authoring$/mu,
		);
		expect(canonicalRepositoryAgentInstructions).toMatch(
			/收尾.*必须先调用 skill `cline-kanban-post-deploy-verification-authoring`/u,
		);
		expect(canonicalRepositoryAgentInstructions).toContain("reconcile 模式");
		expect(canonicalRepositoryAgentInstructions).toContain("kanban task rvf-history");
		expect(canonicalRepositoryAgentInstructions).toContain("证据不足是 `unknown`，不能据此断言没有 RVF");
	});

	it("最终整合规则继续遵守显式 Stop 与任务权限边界", () => {
		expect(canonicalRepositoryAgentInstructions).toMatch(
			/用户显式 Stop、不同步、不得推送或部署等限制及现有权限门禁继续有效/u,
		);
	});
});
