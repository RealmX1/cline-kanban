import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RvfAutomaticCloseoutRecord } from "../../src/core/rvf-automatic-closeout-contract";
import { computeRvfTextSha256 } from "../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";

// 仅验证 Kanban 的消费协议；权威双审判据通过真实 RVF 导出的正负夹具另外联调。
export async function createSupplementalCompletionVerificationProtocolFixture(input: {
	record: RvfAutomaticCloseoutRecord;
	targetCommitSha: string;
	targetTreeSha: string;
	gitCommonDirectoryRealpath: string;
	fixtureRootDirectoryPath: string;
}) {
	const { record } = input;
	if (!record.runDirectory) throw new Error("测试需要绑定 run。");
	const directory = join(record.runDirectory, "artifacts", "supplemental-land-completion-evidence");
	await mkdir(directory, { recursive: true });
	const payload = {
		schema: "rvf-supplemental-land-completion-evidence",
		schema_version: 1,
		binding: {
			task_id: record.taskId,
			decision_token: record.receipt.decision_token,
			run_id: record.runId,
			run_directory: record.runDirectory,
			handoff_sha256: record.handoffSha256,
			target_commit: input.targetCommitSha,
		},
		repository_git_common_directory: input.gitCommonDirectoryRealpath,
		source_snapshots: {
			"artifacts/inputs/scope.contract.json": (
				await readFile(join(record.runDirectory, "artifacts", "inputs", "scope.contract.json"))
			).toString("base64"),
		},
		does_not_attest_precommit_review: true,
		does_not_authorize_followup_execution: true,
	};
	const bytes = JSON.stringify(payload);
	const evidenceSha256 = computeRvfTextSha256(bytes);
	const evidencePath = join(directory, `${evidenceSha256}.json`);
	await writeFile(evidencePath, bytes);
	await writeFile(`${evidencePath}.sha256`, evidenceSha256);
	const configurationPath = join(input.fixtureRootDirectoryPath, "supplemental-verifier-response-configuration.json");
	const invocationLogPath = join(input.fixtureRootDirectoryPath, "supplemental-verifier-invocations.jsonl");
	await writeFile(configurationPath, JSON.stringify({ status: "acceptable" }));
	await writeFile(invocationLogPath, "");
	const protocolScriptBody = `
if (args[0] === 'land') {
  const fs = require('node:fs');
  fs.appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(args)+'\\n');
  const configuration = JSON.parse(fs.readFileSync(${JSON.stringify(configurationPath)}, 'utf8'));
  const expected = ${JSON.stringify([
		"land",
		"supplemental-completion",
		"verify",
		"--repo",
		record.receipt.worktree,
		"--task-id",
		record.taskId,
		"--decision-token",
		record.receipt.decision_token,
		"--run-id",
		record.runId,
		"--run-dir",
		record.runDirectory,
		"--handoff-sha256",
		record.handoffSha256,
		"--target-commit",
		input.targetCommitSha,
		"--evidence",
		evidencePath,
		"--evidence-sha256",
		evidenceSha256,
  ])};
  const status = JSON.stringify(args) === JSON.stringify(expected) ? configuration.status : 'invalid_evidence';
  process.stdout.write(JSON.stringify(status === 'acceptable' ? {
    status,
    historical_completion: {status:'verified', target_commit:${JSON.stringify(input.targetCommitSha)}, target_tree:${JSON.stringify(input.targetTreeSha)}},
    current_execution_eligibility: {status:'requires_current_authorization_check', stop_restrictions_unchanged:true, task_id:${JSON.stringify(record.taskId)}},
    evidence_path:${JSON.stringify(evidencePath)}, evidence_sha256:${JSON.stringify(evidenceSha256)},
    ...configuration.responseOverride,
  } : {status, reason:'测试生产方尚未接受历史完成证明'}));
  process.exit(status === 'acceptable' ? 0 : status === 'awaiting_machine_evidence' ? 3 : status === 'execution_prohibited' ? 5 : 4);
}
`;
	const executablePath = join(input.fixtureRootDirectoryPath, "supplemental-completion-read-only-verifier.cjs");
	await writeFile(
		executablePath,
		`#!${process.execPath}\nconst args=process.argv.slice(2);\n${protocolScriptBody}\nprocess.exit(2);\n`,
	);
	await chmod(executablePath, 0o700);
	return {
		reference: { evidencePath, evidenceSha256 },
		payload,
		configurationPath,
		invocationLogPath,
		executablePath,
		protocolScriptBody,
	};
}
