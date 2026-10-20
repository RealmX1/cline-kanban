const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const nativeMessage = JSON.parse(process.argv[2]);
const options = JSON.parse(process.argv[3]);
require(`${options.sourceRoot}/node_modules/tsx/dist/cjs/index.cjs`);
const { withRunningCodexAppServerControlSocketConnection } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/codex-app-server-request-connection.ts`);
const { captureRvfReviewStartBoundary } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/capture-rvf-review-start-boundary.ts`);
const { observeRvfReviewStartActiveBranch } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/observe-rvf-review-start-active-branch.ts`);
const { readCodexNativeReviewStartMessageEvidence } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/codex-native-review-start-message-evidence.ts`);

withRunningCodexAppServerControlSocketConnection(async (port) => {
 const tokenPath = `${options.rvfHome}/agentic-initiation-decision-tokens/0123456789abcdef.json`;
 const receiptPath = `${options.rvfHome}/review-start-independent-user-turn-boundary-receipts/0123456789abcdef.json`;
 let receipt;
 if (options.afterRewind) receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
 else {
  const token = {
   token: "0123456789abcdef", session_id: nativeMessage.session_id, worktree: options.repositoryPath,
   candidate_fingerprint: "native-candidate", state: "injected", minted_at: options.mintedAt,
   expires_at: new Date(Date.now() + 120000).toISOString(), initiated_by_explicit_user_request: false,
   candidate_summary: {
    kanban_task_id: "synthetic-native-task", committed_round_baseline: null, committed_round_base_ref: "main",
    candidates: [{ path: "implementation.txt", included_in_candidate_set: true,
     content_sha256: createHash("sha256").update(readFileSync(`${options.repositoryPath}/implementation.txt`)).digest("hex") }],
   },
  };
  mkdirSync(`${options.rvfHome}/agentic-initiation-decision-tokens`, { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(token));
  receipt = (await captureRvfReviewStartBoundary({ decisionToken: token.token, taskId: "synthetic-native-task",
   nativeSessionId: nativeMessage.session_id, transcriptPath: nativeMessage.transcript_path,
   workingDirectory: options.repositoryPath, rvfHome: options.rvfHome, port })).receipt;
 }
 if (options.consumerRepository && !options.afterRewind) {
  const code = `import sys,json
sys.path.insert(0,sys.argv[1])
from core.review_start_boundary.review_start_boundary_verification import verify_independent_user_turn_boundary
from adapters.codex.review_start_independent_user_turn_evidence import read_independent_user_turn_boundary_evidence
value=json.load(sys.stdin)
token=value['token']
verify_independent_user_turn_boundary(value['receipt'],token_payload=token,repo=token['worktree'],session_id=token['session_id'],native_boundary_reader=read_independent_user_turn_boundary_evidence,candidate_summary_builder=lambda:token['candidate_summary']|{'candidate_fingerprint':token['candidate_fingerprint']})
print('ACTUAL_RVF_CONSUMER_REAL_NATIVE_BOUNDARY_VERIFIED')`;
  const environment = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  environment.PYTHONDONTWRITEBYTECODE = "1";
  const result = spawnSync("python3", ["-c", code, options.consumerRepository], { encoding: "utf8",
   input: JSON.stringify({ receipt, token: JSON.parse(readFileSync(tokenPath, "utf8")) }), env: environment });
  if (result.status !== 0) throw new Error(result.stderr);
  process.stdout.write(result.stdout);
 }
 const observation = await observeRvfReviewStartActiveBranch({ port, receipt, requestNonce: randomUUID() });
 const staticEvidence = await readCodexNativeReviewStartMessageEvidence({ transcriptPath: nativeMessage.transcript_path,
  nativeSessionId: nativeMessage.session_id, nativeTurnId: nativeMessage.native_turn_id,
  nativeMessageId: nativeMessage.native_user_message_id, text: "RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef" });
 console.log(`NATIVE_BRANCH_PROBE_RESULT ${JSON.stringify({ afterRewind: options.afterRewind, receipt, observation, staticEvidence })}`);
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
