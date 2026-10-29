// generation 链路上两处与「退出确认」相关的契约：
// - 拒绝接管：listing 之后、拒绝之前到达的退出（暂存在链路里，host 不会再推第二次）也必须被确认，
//   否则旧 generation host 永远排不空、退不了休（backlog 9c0dd）；
// - 计划内 handover 冻结之后：输出不再送进句柄、退出不交付也不确认（留给下一个 runtime 从 listing 里取），
//   连接随后断开也不把句柄按 SIGHUP 退出处理。
import { describe, expect, it, vi } from "vitest";
import type {
	AgentSessionPtyHostControllerConnection,
	AgentSessionPtyHostControllerConnectionEventHandlers,
} from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostGenerationControllerLink } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-generation-controller-link";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "../../../src/agent-session-pty-host/runtime-client/hosted-terminal-pty-process-handle-over-agent-session-pty-host";
import type { AgentSessionPtyHostControllerToHostMessage } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";

class FakeControllerConnectionRecordingControlMessages {
	isClosed = false;
	readonly sentControlMessages: AgentSessionPtyHostControllerToHostMessage[] = [];
	eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers | null = null;

	setEventHandlers(eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers): void {
		this.eventHandlers = eventHandlers;
	}

	sendControlMessage(message: AgentSessionPtyHostControllerToHostMessage): void {
		this.sentControlMessages.push(message);
	}

	sendHostedSessionInputBytes(): void {}
}

function createLinkOverFakeConnection() {
	const fakeConnection = new FakeControllerConnectionRecordingControlMessages();
	const link = new AgentSessionPtyHostGenerationControllerLink(
		"/tmp/fake-agent-session-pty-host.sock",
		fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
		() => {},
		() => {},
	);
	const emitFromHost = () => {
		if (fakeConnection.eventHandlers === null) {
			throw new Error("link did not install event handlers");
		}
		return fakeConnection.eventHandlers;
	};
	return { fakeConnection, link, emitFromHost };
}

describe("AgentSessionPtyHostGenerationControllerLink exit acknowledgement", () => {
	it("acknowledges an exit that arrived after listing but before the adoption was refused, instead of stopping a dead session", () => {
		const { fakeConnection, link, emitFromHost } = createLinkOverFakeConnection();
		emitFromHost().onHostedSessionExited?.("hosted-session-exited-before-refusal", {
			exitCode: 0,
			signal: null,
			exitedAtEpochMs: 1_700_000_000_000,
		});

		link.terminateHostedSessionWithoutHandle("hosted-session-exited-before-refusal", false);

		expect(fakeConnection.sentControlMessages).toEqual([
			{
				type: "acknowledge_hosted_session_exit",
				hostedSessionKey: "hosted-session-exited-before-refusal",
				discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession: true,
			},
		]);
	});

	it("still stops a refused session that is running and acknowledges its exit once it arrives", () => {
		const { fakeConnection, link, emitFromHost } = createLinkOverFakeConnection();

		link.terminateHostedSessionWithoutHandle("hosted-session-running-at-refusal", false);
		expect(fakeConnection.sentControlMessages).toEqual([
			{ type: "stop_hosted_session", hostedSessionKey: "hosted-session-running-at-refusal", force: true },
		]);
		emitFromHost().onHostedSessionExited?.("hosted-session-running-at-refusal", {
			exitCode: 137,
			signal: 9,
			exitedAtEpochMs: 1_700_000_000_000,
		});

		expect(fakeConnection.sentControlMessages.at(-1)).toEqual({
			type: "acknowledge_hosted_session_exit",
			hostedSessionKey: "hosted-session-running-at-refusal",
			discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession: true,
		});
	});
});

describe("AgentSessionPtyHostGenerationControllerLink planned handover freeze", () => {
	it("stops delivering output and exits to handles and never acknowledges an exit after the freeze", () => {
		const { fakeConnection, link, emitFromHost } = createLinkOverFakeConnection();
		const onData = vi.fn();
		const onExit = vi.fn();
		const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
			fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
			"hosted-session-a",
			7,
			4242,
			onData,
			onExit,
		);
		link.registerHandleAndDeliverEventsThatArrivedEarlier(handle);
		emitFromHost().onHostedSessionOutput?.(7, 0, Buffer.from("before freeze"));
		expect(handle.outputByteOffsetAfterLastDeliveredChunk).toBe("before freeze".length);

		link.freezeHostedSessionEventRoutingForRuntimeHandover();
		emitFromHost().onHostedSessionOutput?.(7, "before freeze".length, Buffer.from("after freeze"));
		emitFromHost().onHostedSessionExited?.("hosted-session-a", {
			exitCode: 0,
			signal: null,
			exitedAtEpochMs: 1_700_000_000_000,
		});
		emitFromHost().onConnectionClosed?.("connection_closed");

		expect(onData).toHaveBeenCalledTimes(1);
		// 偏移停在冻结那一刻：checkpoint 与之对齐。
		expect(handle.outputByteOffsetAfterLastDeliveredChunk).toBe("before freeze".length);
		expect(onExit).not.toHaveBeenCalled();
		expect(fakeConnection.sentControlMessages).toEqual([]);
	});

	it("makes a detached handle inert: it never signals the process it handed over", () => {
		const { fakeConnection } = createLinkOverFakeConnection();
		const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
			fakeConnection as unknown as AgentSessionPtyHostControllerConnection,
			"hosted-session-b",
			8,
			4343,
			vi.fn(),
			vi.fn(),
		);
		handle.publishTerminalSessionAdoptionRecordForRuntimeRestart({ recordedBy: "final" }, 1_800_000_000_000);
		handle.detachFromRuntimeForHandoverRestartWithoutSignallingProcess();
		handle.stop({ interrupted: true, force: true });
		handle.write("late keystroke");
		handle.resize(100, 30);

		expect(fakeConnection.sentControlMessages).toEqual([
			{
				type: "put_hosted_session_adoption_record",
				hostedSessionKey: "hosted-session-b",
				adoptionRecord: { recordedBy: "final" },
				hostedSessionOrphanReclamationEligibleAtEpochMs: 1_800_000_000_000,
			},
		]);
	});
});
