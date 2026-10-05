import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminatePtyProcessGroup } from "../../../src/terminal/pty-process-group-termination-signal-policy";

const FAKE_PTY_PROCESS_GROUP_LEADER_PID = 424242;

function createFakePtyProcessTerminationTarget() {
	return { pid: FAKE_PTY_PROCESS_GROUP_LEADER_PID, kill: vi.fn() };
}

describe.skipIf(process.platform === "win32")("terminatePtyProcessGroup", () => {
	let processKillSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		processKillSpy.mockRestore();
		vi.useRealTimers();
	});

	it("sends node-pty's default signal to the leader and SIGTERM to the process group without escalation by default", () => {
		const target = createFakePtyProcessTerminationTarget();

		terminatePtyProcessGroup(target);
		vi.advanceTimersByTime(60_000);

		expect(target.kill.mock.calls).toEqual([[]]);
		expect(processKillSpy.mock.calls).toEqual([[-FAKE_PTY_PROCESS_GROUP_LEADER_PID, "SIGTERM"]]);
	});

	it("sends SIGKILL to the leader and the process group when forced", () => {
		const target = createFakePtyProcessTerminationTarget();

		terminatePtyProcessGroup(target, { force: true });

		expect(target.kill.mock.calls).toEqual([["SIGKILL"]]);
		expect(processKillSpy.mock.calls).toEqual([[-FAKE_PTY_PROCESS_GROUP_LEADER_PID, "SIGKILL"]]);
	});

	it("escalates to SIGKILL after the configured delay when the process has not exited", () => {
		const target = createFakePtyProcessTerminationTarget();

		terminatePtyProcessGroup(target, { escalateToSigkillAfterMs: 5_000, hasProcessExited: () => false });
		vi.advanceTimersByTime(4_999);
		expect(target.kill.mock.calls).toEqual([[]]);

		vi.advanceTimersByTime(1);
		expect(target.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
		expect(processKillSpy.mock.calls).toEqual([
			[-FAKE_PTY_PROCESS_GROUP_LEADER_PID, "SIGTERM"],
			[-FAKE_PTY_PROCESS_GROUP_LEADER_PID, "SIGKILL"],
		]);
	});

	it("does not escalate when the process has already exited or the escalation was cancelled", () => {
		const exitedTarget = createFakePtyProcessTerminationTarget();
		terminatePtyProcessGroup(exitedTarget, { escalateToSigkillAfterMs: 5_000, hasProcessExited: () => true });
		const cancelledTarget = createFakePtyProcessTerminationTarget();
		const cancelEscalation = terminatePtyProcessGroup(cancelledTarget, {
			escalateToSigkillAfterMs: 5_000,
			hasProcessExited: () => false,
		});
		cancelEscalation();

		vi.advanceTimersByTime(10_000);

		expect(exitedTarget.kill.mock.calls).toEqual([[]]);
		expect(cancelledTarget.kill.mock.calls).toEqual([[]]);
	});
});
