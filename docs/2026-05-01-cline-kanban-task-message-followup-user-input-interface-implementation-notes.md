# Cline Kanban `task message` Follow-up User Input Interface Handoff

Annotated copy of original plan:
`/Users/bominzhang/Documents/GitHub/review-validate-fix/docs/2026-05-01-cline-kanban-task-message-followup-user-input-interface-handoff-for-rvf-kanban-followup.md`

Date: 2026-05-01
Owner context: Review-Validate-Fix (RVF) Stop hook automation
Target implementer: Cline/Kanban app agent

Implementation note, 2026-05-02:
This plan was implemented in the Kanban repo with a narrow host-side API, plus an RVF review/fix pass. The final implementation intentionally does not use terminal PTY fallback for `task message`; it only accepts the Cline chat/user-message path as a successful delivery.

## Summary

RVF now supports an opt-in backend named `kanban-followup`. This backend is intended for a Stop hook that is already running inside a Cline Kanban task. After RVF passes its existing gates, it should not fork Codex and should not create a new Kanban task. Instead, it calls a Kanban host interface that injects a synthetic but real follow-up user message into the current task's active coding-agent chat session.

The Kanban app must provide the missing host-side interface:

```sh
kanban task message \
  --project-path <repo> \
  --task-id <task-id> \
  --prompt-file <absolute-rvf-prompt-file> \
  --source review-validate-fix \
  --idempotency-key <rvf-run-id> \
  [--attempt-id <attempt-id>]
```

This command must use the same internal path as a real user follow-up message sent to the active task agent. It must not be implemented as card activity, task metadata, task prompt update, hook context, system prompt/context injection, or `contextModification`.

Implementation note:
Implemented as `kanban task message` in [src/commands/task.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/src/commands/task.ts). The command resolves the runtime workspace, validates the task exists, reads the prompt, records idempotency state, and sends through `runtime.sendTaskChatMessage`. The RVF review pass removed the earlier terminal `sendTaskSessionInput` fallback because PTY input is not equivalent to a real follow-up user turn.

## Required CLI Contract

Command:

```sh
kanban task message
```

Required arguments:

- `--project-path <repo>`: Kanban project path used to find the project/task database.
- `--task-id <task-id>`: Current Kanban task id. RVF passes `KANBAN_TASK_ID`, `CLINE_KANBAN_TASK_ID`, event `kanban_task_id`, or event `task_id`.
- `--prompt-file <path>`: File containing the complete follow-up user message. The file is UTF-8 markdown/plain text.
- `--source review-validate-fix`: Source label for auditability and UI history.
- `--idempotency-key <rvf-run-id>`: Unique RVF run id. The same `task_id + idempotency_key` must inject at most one user message.

Optional arguments:

- `--attempt-id <attempt-id>`: Preferred current task attempt/session if Kanban distinguishes attempts. If omitted, Kanban must resolve the active attempt for the task.
- `--prompt <text>` may be supported for convenience, but RVF currently uses `--prompt-file`.

Required stdout on success:

```json
{
  "ok": true,
  "task_id": "task-123",
  "attempt_id": "attempt-456",
  "message_id": "msg-789",
  "turn_id": "turn-optional",
  "checkpoint_id": "checkpoint-optional",
  "status": "queued"
}
```

Required fields:

- `ok: true`
- `task_id`
- `message_id`

Optional but strongly recommended fields:

- `attempt_id`
- `turn_id`
- `checkpoint_id`
- `status`: `queued`, `started`, or another explicit state.

Failure stdout/stderr:

- Exit non-zero.
- Prefer JSON with `ok: false` and a human-readable `error`.
- Do not partially inject a message and then report failure.

Example failure:

```json
{
  "ok": false,
  "error": "task has no active agent session"
}
```

Implementation note:
Implemented arguments match the plan, with two deliberate constraints:

- `--prompt-file` and `--prompt` are mutually exclusive; at least one is required.
- `--attempt-id` is accepted, but Kanban currently treats task id as the session-compatible id. A provided `attempt_id` must equal `task_id`; otherwise the command exits non-zero.

The success result includes `ok`, `task_id`, `message_id`, optional `attempt_id`, optional checkpoint-derived `turn_id` / `checkpoint_id`, and `status`. Failure uses the existing CLI JSON error wrapper.

## Required Host Behavior

The command must resolve the task and active agent session, then enqueue the supplied prompt as the next real user turn for that session.

Expected behavior:

- If the task agent is idle, start the next user turn immediately or enqueue it and report `status`.
- If the task agent is currently processing a prior turn, enqueue this prompt as the next user turn for the same task/session.
- If the task has multiple attempts, use `--attempt-id` when provided; otherwise use the active/current attempt shown in the Kanban UI.
- The injected message must appear in the task conversation transcript/history as a user-authored message or a host-authored user-equivalent follow-up.
- The task UI should show that the message source is `review-validate-fix`, while preserving user-turn semantics for the agent runtime.
- The agent runtime must receive the message through its normal user-message API.

Backend-specific expectations:

- Cline SDK backend: use the equivalent of sending a user prompt to the active agent/session, not a context mutation.
- Codex backend: start a new turn on the current thread/session, not `thread/fork`.
- Claude Code backend: host must feed the message through the SDK/controlled user input path so it behaves like a user prompt. File checkpointing alone is not enough if the conversation does not receive a real user message.

Implementation note:
Implemented for Kanban's native Cline chat path:

- [src/trpc/runtime-api.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/src/trpc/runtime-api.ts) forwards source/idempotency metadata to Cline task sessions.
- [src/cline-sdk/cline-task-session-service.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/src/cline-sdk/cline-task-session-service.ts) stores the follow-up as a user message with metadata and dispatches through the normal Cline session input path.
- [src/cline-sdk/cline-session-state.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/src/cline-sdk/cline-session-state.ts) now allows `source`, `idempotencyKey`, and `promptSha256` metadata.
- [web-ui/src/components/detail-panels/cline-chat-message-item.tsx](/Users/bominzhang/Documents/GitHub/cline-kanban/web-ui/src/components/detail-panels/cline-chat-message-item.tsx) displays the source label on user messages.

No Codex or Claude backend-specific follow-up implementation was added here. This implementation targets the current Kanban Cline task chat path.

## Idempotency

Idempotency is mandatory because Stop hooks may be retried.

The key is:

```text
task_id + idempotency_key
```

Rules:

- First call injects exactly one message and stores the injection record.
- Repeat call with the same `task_id + idempotency_key` returns the existing `message_id` and related ids.
- Repeat call must not enqueue a duplicate message.
- If the first call failed before injection, a retry may attempt injection.
- If the first call injected but failed before returning, a retry must discover and return the existing injection if possible.

Recommended persistent record fields:

```json
{
  "task_id": "task-123",
  "attempt_id": "attempt-456",
  "source": "review-validate-fix",
  "idempotency_key": "rvf-...",
  "prompt_sha256": "...",
  "message_id": "msg-789",
  "turn_id": "turn-optional",
  "checkpoint_id": "checkpoint-optional",
  "created_at": "2026-05-01T00:00:00Z"
}
```

If a repeated call uses the same idempotency key but a different prompt hash, return a non-zero conflict error. Do not inject a second message.

Implementation note:
Implemented with `task-message-injections.json` in the workspace state directory, protected by `lockedFileSystem.withLock`.

RVF review found the first implementation wrote the idempotency record after sending, which could duplicate on retry if the process died after delivery but before persistence. The fixed implementation writes a `pending` claim before delivery, replaces it with the completed record after `sendTaskChatMessage` returns a real `message.id`, and rejects automatic replay if the same key is still pending. Different prompt hash with the same key exits as a conflict.

This is conservative: it prevents duplicate injection, but a manually inspected stale `pending` record may need operator cleanup if the process died in the narrow window between claim and delivery result.

## RVF Prompt Shape

RVF writes a prompt file similar to:

```text
$review-validate-fix

RVF_KANBAN_FOLLOWUP_TRIGGER
RVF_RUN_ID: rvf-...
RVF_TARGET_REPO: /path/to/repo
RVF_CURRENT_TASK_ID: task-123
RVF_CURRENT_ATTEMPT_ID: attempt-456
RVF_CURRENT_CWD: /path/to/repo

这是由 Cline Kanban host 在当前 task 的 coding agent chat session 中注入的真实用户消息...
```

Kanban should not parse this prompt for behavior except for audit/debug fields if useful. The important requirement is to inject the entire file content as the next user message.

`RVF_KANBAN_FOLLOWUP_TRIGGER` is a one-shot recursion marker. RVF Stop hook checks only the latest user message for this marker so the RVF-triggered turn does not immediately trigger another RVF run after it stops. Kanban must not strip this marker.

Implementation note:
Implemented as opaque prompt delivery. The command hashes the exact prompt content for idempotency and sends the content as the user message. It does not parse or strip `RVF_KANBAN_FOLLOWUP_TRIGGER`.

## Environment/Event Inputs RVF Expects

When running an agent inside a Kanban task, expose at least:

```sh
KANBAN_TASK_ID=<task-id>
```

Recommended:

```sh
KANBAN_ATTEMPT_ID=<attempt-id>
KANBAN_PROJECT_PATH=<project-path>
```

RVF also accepts compatibility names:

```sh
CLINE_KANBAN_TASK_ID=<task-id>
CLINE_KANBAN_ATTEMPT_ID=<attempt-id>
CLINE_KANBAN_PROJECT_PATH=<project-path>
```

Equivalent Stop event JSON fields are also acceptable:

```json
{
  "task_id": "task-123",
  "attempt_id": "attempt-456",
  "project_path": "/path/to/project"
}
```

Implementation note:
Implemented in [src/terminal/session-manager.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/src/terminal/session-manager.ts). Task agents now receive:

- `KANBAN_TASK_ID`
- `KANBAN_ATTEMPT_ID`
- `CLINE_KANBAN_TASK_ID`
- `CLINE_KANBAN_ATTEMPT_ID`
- `KANBAN_PROJECT_PATH`
- `CLINE_KANBAN_PROJECT_PATH`

Current attempt id is set to the task id until Kanban has a separate attempt/session id model.

## Non-goals

Do not implement this interface by:

- Updating the task's original prompt.
- Creating a new task.
- Creating a new worktree.
- Sending a Kanban activity/comment that is not delivered to the agent as a user turn.
- Adding context through hook `contextModification`.
- Appending a system prompt or hidden context.
- Forking a Codex/Claude conversation behind RVF's back.

The point of this interface is to produce a checkpointable, visible, current-session user turn.

Implementation note:
The final implementation follows these non-goals. It does not mutate card prompt/metadata for delivery, does not create a task/worktree, does not use hidden context, and does not fork conversations. The initial terminal PTY fallback was removed during RVF validate/fix because it did not satisfy this section.

## Acceptance Criteria

Minimum acceptance tests for Kanban:

1. Running `kanban task message ...` against an idle active task creates exactly one visible follow-up user message in the current task conversation.
2. Running the same command twice with the same `task_id + idempotency_key` returns the same `message_id` and does not enqueue a duplicate.
3. Running the command while the agent is busy queues exactly one next user turn for the same task/session.
4. The agent receives the message through the same user-message path as a manual user follow-up in the Kanban UI.
5. The message appears in task history/checkpoint UI as a user turn or user-equivalent host turn with source `review-validate-fix`.
6. The command fails non-zero when no active task agent session exists.
7. The command fails non-zero when `--attempt-id` is provided but does not belong to the task.
8. The command fails non-zero on idempotency conflict with a different prompt hash.

RVF-side smoke test:

```sh
CODEX_RVF_FORK_MODE=kanban-followup \
KANBAN_TASK_ID=<task-id> \
KANBAN_ATTEMPT_ID=<attempt-id> \
KANBAN_PROJECT_PATH=<repo> \
python3 plugins/review-validate-fix/skills/review-validate-fix/scripts/codex_stop_review_validate_fix.py < stop-event.json
```

Expected RVF result:

- `systemMessage` includes `reason=kanban_followup_enqueued` or `reason=kanban_followup_started`.
- RVF run summary contains `backend: "kanban-followup"`.
- RVF run summary contains `cline_kanban_task_id` and `cline_kanban_message_id`.
- Kanban task conversation receives a new `$review-validate-fix` user message.

Implementation note:
Implemented and validated by focused automated tests, but not every acceptance item has a direct CLI-level integration test yet.

Covered:

- Metadata forwarding through `runtime.sendTaskChatMessage` is covered in [test/runtime/trpc/runtime-api.test.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/test/runtime/trpc/runtime-api.test.ts).
- Kanban task/project environment propagation is covered in [test/runtime/terminal/session-manager-auto-restart.test.ts](/Users/bominzhang/Documents/GitHub/cline-kanban/test/runtime/terminal/session-manager-auto-restart.test.ts).
- Attempt mismatch and prompt hash conflict are enforced in command code.
- No-active-chat-session now fails instead of falling back to terminal PTY.

Still worth adding later:

- A CLI/integration test for `kanban task message` idempotency record creation and repeat behavior.
- A busy-session queue behavior test that asserts delivery remains on the Cline user-message path.
- An RVF-side smoke test after the RVF Stop hook backend-discovery issue is fixed.

## Maintenance Notes

- This interface should be treated as a stable Kanban host API, not a temporary npm-package patch.
- If implemented only in a local `node_modules` or `npx` cache patch, it will likely be lost on the next Kanban update.
- Prefer implementing it upstream or in a pinned Kanban fork/package used by the RVF environment.
- Preserve backward compatibility for existing `kanban task create/start/trash`; `task message` is additive.
- Future RVF versions may add optional metadata fields, but should continue to work with the minimum required response fields above.

Implementation note:
Implemented directly in the Kanban source tree, additively to the existing `task` command group. Existing `task create/start/trash` commands were left intact. The metadata additions are optional at API boundaries so older callers that only send text/images/mode continue to work.
