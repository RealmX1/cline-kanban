import { describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerSocketServer } from "../../../src/agent-session-pty-host/host-process/agent-session-pty-host-controller-socket-server";
import type { AgentSessionPtyHostControllerConnection } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "../../../src/agent-session-pty-host/runtime-client/hosted-terminal-pty-process-handle-over-agent-session-pty-host";
import {
	AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH,
	encodeJsonControlMessageFrame,
} from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-frame-codec";
import type { AgentSessionPtyHostHostedSessionListing } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import {
	createTerminalProtocolFilterState,
	filterTerminalProtocolOutput,
} from "../../../src/terminal/terminal-protocol-filter";
import type { ActiveProcessState } from "../../../src/terminal/terminal-session-active-process-state";
import { capturePlannedHandoverTerminalMirrorCheckpoint } from "../../../src/terminal/terminal-session-planned-handover-terminal-mirror-checkpoint";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

describe("handover checkpoint 的 UTF-8 与控制帧预算", () => {
	it.each(["中", "😀"])("在 %s 的每个字节边界捕获后仍能完整续流", async (character) => {
		const characterBytes = Buffer.from(character);
		for (let split = 1; split < characterBytes.length; split++) {
			const original = new TerminalStateMirror(80, 24);
			const restored = new TerminalStateMirror(80, 24);
			try {
				const prefix = Buffer.concat([Buffer.from("prefix:"), characterBytes.subarray(0, split)]);
				const suffix = Buffer.concat([characterBytes.subarray(split), Buffer.from("文")]);
				const protocolFilter = createTerminalProtocolFilterState();
				original.applyOutput(filterTerminalProtocolOutput(protocolFilter, prefix, {}));
				const outcome = await capturePlannedHandoverTerminalMirrorCheckpoint({
					terminalStateMirror: original,
					active: {
						session: { outputByteOffsetAfterLastDeliveredChunk: prefix.length },
						terminalProtocolFilter: protocolFilter,
					} as ActiveProcessState,
				});
				expect(outcome.kind).toBe("captured");
				if (outcome.kind !== "captured") throw new Error("缺少 checkpoint");
				const checkpoint = outcome.checkpoint;
				original.applyOutput(suffix);
				restored.applyOutput(Buffer.from(checkpoint.serializedTerminalMirrorSnapshot));
				restored.applyOutput(
					Buffer.concat([prefix, suffix]).subarray(checkpoint.outputByteOffsetCoveredBySnapshot),
				);
				expect((await restored.getScreenSnapshot()).lines.map((line) => line.text)).toEqual(
					(await original.getScreenSnapshot()).lines.map((line) => line.text),
				);
			} finally {
				original.dispose();
				restored.dispose();
			}
		}
	});

	it.each(["中", "\u001b"])("单条 checkpoint 按 JSON 编码后的 %s 字节预算降级", async (character) => {
		const outcome = await capturePlannedHandoverTerminalMirrorCheckpoint({
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: character.repeat(6 * 1024 * 1024), cols: 80, rows: 24 }),
			} as TerminalStateMirror,
			active: {
				session: { outputByteOffsetAfterLastDeliveredChunk: 100 },
				terminalProtocolFilter: createTerminalProtocolFilterState(),
			} as ActiveProcessState,
		});
		expect(outcome.kind).toBe("not_captured");
	});

	it("发布最终记录时也计入记录元数据和 JSON 转义的总预算", () => {
		const sentFrames: Buffer[] = [];
		const connection = {
			sendControlMessage: (message: unknown) => sentFrames.push(encodeJsonControlMessageFrame(message)),
		} as unknown as AgentSessionPtyHostControllerConnection;
		const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
			connection,
			"session",
			1,
			42,
			() => {},
			() => {},
		);
		expect(() =>
			handle.publishTerminalSessionAdoptionRecordForRuntimeRestart({
				identity: "保留的身份",
				plannedHandoverTerminalMirrorCheckpoint: {
					serializedTerminalMirrorSnapshot: "\u001b".repeat(3 * 1024 * 1024),
				},
			}),
		).not.toThrow();
		expect(JSON.parse(sentFrames[0].subarray(5).toString()).adoptionRecord).toEqual({ identity: "保留的身份" });
	});

	it("多个合法 checkpoint 的 listing 总帧超限时保留会话身份并降级 checkpoint", () => {
		const listings: AgentSessionPtyHostHostedSessionListing[] = Array.from({ length: 3 }, (_, index) => ({
			hostedSessionKey: `session-${index}`,
			hostedSessionChannelNumber: index + 1,
			hostedSessionDescriptor: {
				workspaceId: "workspace",
				taskId: `task-${index}`,
				hostedSessionKind: "task_agent_session",
			},
			pid: 100 + index,
			spawnedAtEpochMs: 1,
			cols: 80,
			rows: 24,
			retainedOutputStartByteOffset: 0,
			outputEndByteOffset: 10,
			exitRecord: null,
			adoptionRecord: {
				identity: `identity-${index}`,
				plannedHandoverTerminalMirrorCheckpoint: {
					serializedTerminalMirrorSnapshot: "a".repeat(6 * 1024 * 1024),
					cols: 80,
					rows: 24,
					outputByteOffsetCoveredBySnapshot: 10,
				},
			},
		}));
		const server = new AgentSessionPtyHostControllerSocketServer({
			socketPath: "/unused-test-socket",
			hostBuildIdentity: "test",
			spawnHostedPtyProcess: () => {
				throw new Error("禁止 spawn");
			},
			idleExitAfterMilliseconds: 60_000,
			unacknowledgedExitRecordRetentionMilliseconds: 60_000,
			appendHostLogEntry: () => {},
			requestHostProcessExit: () => {},
		});
		const internals = server as unknown as {
			hostedSessionRegistry: { listHostedSessions: () => AgentSessionPtyHostHostedSessionListing[] };
			currentControllerSocket: unknown;
			handleControllerControlMessage: (message: unknown) => void;
		};
		vi.spyOn(internals.hostedSessionRegistry, "listHostedSessions").mockReturnValue(listings);
		const write = vi.fn<(frame: Buffer) => boolean>(() => true);
		internals.currentControllerSocket = { destroyed: false, write };
		expect(() =>
			internals.handleControllerControlMessage({ type: "list_hosted_sessions_request", requestId: "list" }),
		).not.toThrow();
		expect(write).toHaveBeenCalledOnce();
		const frame = write.mock.calls[0][0] as Buffer;
		expect(frame.byteLength - 5).toBeLessThanOrEqual(AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH);
		const response = JSON.parse(frame.subarray(5).toString());
		expect(
			response.hostedSessions.map((listing: AgentSessionPtyHostHostedSessionListing) => listing.hostedSessionKey),
		).toEqual(listings.map((listing) => listing.hostedSessionKey));
		expect(
			response.hostedSessions.map(
				(listing: { adoptionRecord: { identity: string } }) => listing.adoptionRecord.identity,
			),
		).toEqual(["identity-0", "identity-1", "identity-2"]);
		expect(
			listings.every(
				(listing) =>
					(listing.adoptionRecord as Record<string, unknown>).plannedHandoverTerminalMirrorCheckpoint !==
					undefined,
			),
		).toBe(true);
	});
});
