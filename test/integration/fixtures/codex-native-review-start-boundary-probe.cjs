const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const nativeMessage = JSON.parse(process.argv[2]);
const options = JSON.parse(process.argv[3]);
require(`${options.sourceRoot}/node_modules/tsx/dist/cjs/index.cjs`);
const { withRunningCodexAppServerControlSocketConnection } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/codex-app-server-request-connection.ts`);
const { captureRvfReviewStartBoundary } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/capture-rvf-review-start-boundary.ts`);
const { observeRvfReviewStartActiveBranch } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/observe-rvf-review-start-active-branch.ts`);
const { readCodexNativeReviewStartMessageEvidence } = require(`${options.sourceRoot}/src/rvf-automatic-closeout/codex-native-review-start-message-evidence.ts`);

async function verifyActualConsumerLiveBranch(receipt, token, port) {
 if (!options.consumerRepository) return;
 const code = `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
sys.path.insert(0,str(Path(sys.argv[1])/'plugins/review-validate-fix/skills/review-validate-fix/scripts'))
import cline_kanban_client as client
from review_start_boundary_gate import _read_or_reconcile_host_boundary_receipt
from core.review_start_boundary.review_start_boundary_verification import ReviewStartBoundaryNotVerified
value=json.loads(sys.argv[2])
def read_live_status(**kwargs):
 print('NATIVE_NONCE_QUERY '+json.dumps({'nonce':kwargs['review_start_boundary_observation_nonce']}),flush=True)
 return json.loads(sys.stdin.readline())
client.read_task_message_terminal_delivery_status=read_live_status
try:
 _read_or_reconcile_host_boundary_receipt(value['token'],value['receipt'])
except ReviewStartBoundaryNotVerified as exc:
 if not value['afterRewind']: raise
 if '活动分支' not in str(exc): raise
 print('ACTUAL_RVF_CONSUMER_REWOUND_BRANCH_REJECTED',flush=True)
else:
 if value['afterRewind']: raise AssertionError('真实回退分支被错误接受')
 print('ACTUAL_RVF_CONSUMER_CURRENT_BRANCH_ACCEPTED',flush=True)
`;
 const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
 Object.assign(env, { PYTHONDONTWRITEBYTECODE: "1", RVF_HOME: options.rvfHome });
 const child = spawn("python3", ["-u", "-c", code, options.consumerRepository, JSON.stringify({ receipt, token, afterRewind: options.afterRewind })], { env, stdio: ["pipe", "pipe", "pipe"] });
 const reader = createInterface({ input: child.stdout });
 let stdout = "", stderr = "", queryError;
 child.stderr.on("data", bytes => { stderr += String(bytes); });
 reader.on("line", line => {
  if (!line.startsWith("NATIVE_NONCE_QUERY ")) { stdout += line + "\n"; return; }
  const nonce = JSON.parse(line.slice("NATIVE_NONCE_QUERY ".length)).nonce;
  // 消费者随机 nonce 先到达，再由当前宿主发起真实查询。
  observeRvfReviewStartActiveBranch({ port, receipt, requestNonce: nonce }).then(observation => {
   child.stdin.write(JSON.stringify({ independent_user_turn_boundary_receipt: receipt, review_start_boundary_active_branch_observation: observation }) + "\n");
  }).catch(error => { queryError = error; child.kill("SIGTERM"); });
 });
 try {
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (queryError) throw queryError;
  if (status !== 0) throw new Error(stderr + stdout);
  process.stdout.write(stdout);
 } finally {
  reader.close();
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
 }
}

withRunningCodexAppServerControlSocketConnection(async (port) => {
 const tokenPath = `${options.rvfHome}/agentic-initiation-decision-tokens/0123456789abcdef.json`;
 const receiptPath = `${options.rvfHome}/review-start-independent-user-turn-boundary-receipts/0123456789abcdef.json`;
 let receipt;
 if (options.afterRewind) receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
 else {
  const token = {
   token: "0123456789abcdef", session_id: nativeMessage.session_id, worktree: options.repositoryPath,
   candidate_fingerprint: "native-candidate", state: "injected", minted_at: options.mintedAt,
   expires_at: new Date(Date.now() + 120000).toISOString(), initiated_by_explicit_user_request: options.manualCommand === true,
   explicit_user_request_provenance: options.manualCommand ? "developer_manual_trigger_via_user_prompt_submit" : null,
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
 await verifyActualConsumerLiveBranch(receipt, JSON.parse(readFileSync(tokenPath, "utf8")), port);
 const staticEvidence = await readCodexNativeReviewStartMessageEvidence({ transcriptPath: nativeMessage.transcript_path,
  nativeSessionId: nativeMessage.session_id, nativeTurnId: nativeMessage.native_turn_id,
  nativeMessageId: nativeMessage.native_user_message_id, text: options.boundaryText || "RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef" });
 console.log(`NATIVE_BRANCH_PROBE_RESULT ${JSON.stringify({ afterRewind: options.afterRewind, receipt, observation, staticEvidence })}`);
}, options.nativeControlSocketPath ? { socketPath: options.nativeControlSocketPath } : undefined).catch(error => { console.error(error.stack); process.exitCode = 1; });
