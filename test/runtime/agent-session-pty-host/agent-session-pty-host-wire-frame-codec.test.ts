import { describe, expect, it } from "vitest";
import {
	AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH,
	AgentSessionPtyHostWireFrameDecoder,
	AgentSessionPtyHostWireFrameDecodingError,
	type DecodedAgentSessionPtyHostWireFrame,
	encodeHostedSessionInputBytesFrame,
	encodeHostedSessionOutputBytesFrame,
	encodeJsonControlMessageFrame,
} from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-frame-codec";

function encodeMixedFrameSequence(): { encoded: Buffer; expected: DecodedAgentSessionPtyHostWireFrame[] } {
	const largeOutputBytes = Buffer.alloc(70_000, 0x61);
	const expected: DecodedAgentSessionPtyHostWireFrame[] = [
		{ kind: "json_control_message", message: { type: "controller_hello", protocolVersion: 1, text: "中文 ✓" } },
		{
			kind: "hosted_session_output_bytes",
			hostedSessionChannelNumber: 7,
			startByteOffset: 2 ** 40 + 3,
			bytes: Buffer.from([0x1b, 0x5b, 0x33, 0x4a, 0x00, 0xff]),
		},
		{ kind: "hosted_session_input_bytes", hostedSessionChannelNumber: 7, bytes: Buffer.from("\r", "utf8") },
		{
			kind: "hosted_session_output_bytes",
			hostedSessionChannelNumber: 1,
			startByteOffset: 0,
			bytes: largeOutputBytes,
		},
		{ kind: "hosted_session_input_bytes", hostedSessionChannelNumber: 2, bytes: Buffer.alloc(0) },
	];
	const encoded = Buffer.concat([
		encodeJsonControlMessageFrame({ type: "controller_hello", protocolVersion: 1, text: "中文 ✓" }),
		encodeHostedSessionOutputBytesFrame(7, 2 ** 40 + 3, Buffer.from([0x1b, 0x5b, 0x33, 0x4a, 0x00, 0xff])),
		encodeHostedSessionInputBytesFrame(7, Buffer.from("\r", "utf8")),
		encodeHostedSessionOutputBytesFrame(1, 0, largeOutputBytes),
		encodeHostedSessionInputBytesFrame(2, Buffer.alloc(0)),
	]);
	return { encoded, expected };
}

describe("agent session pty host wire frame codec", () => {
	it("decodes interleaved frame kinds delivered in a single chunk", () => {
		const { encoded, expected } = encodeMixedFrameSequence();

		expect(new AgentSessionPtyHostWireFrameDecoder().push(encoded)).toEqual(expected);
	});

	it("decodes the same frames when the stream is split at every byte boundary", () => {
		const { encoded, expected } = encodeMixedFrameSequence();
		const decoder = new AgentSessionPtyHostWireFrameDecoder();
		const decoded: DecodedAgentSessionPtyHostWireFrame[] = [];
		for (let byteIndex = 0; byteIndex < encoded.byteLength; byteIndex += 1) {
			decoded.push(...decoder.push(encoded.subarray(byteIndex, byteIndex + 1)));
		}

		expect(decoded).toEqual(expected);
	});

	it("rejects a length field above the maximum payload size", () => {
		const header = Buffer.alloc(5);
		header.writeUInt32BE(AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH + 1, 0);
		header.writeUInt8(1, 4);

		expect(() => new AgentSessionPtyHostWireFrameDecoder().push(header)).toThrow(
			AgentSessionPtyHostWireFrameDecodingError,
		);
	});

	it("rejects unknown frame kinds and malformed json payloads", () => {
		const unknownKindFrame = Buffer.from([0, 0, 0, 0, 9]);
		const malformedJsonFrame = Buffer.concat([Buffer.from([0, 0, 0, 1, 1]), Buffer.from("{", "utf8")]);

		expect(() => new AgentSessionPtyHostWireFrameDecoder().push(unknownKindFrame)).toThrow(/unknown wire frame kind/);
		expect(() => new AgentSessionPtyHostWireFrameDecoder().push(malformedJsonFrame)).toThrow(/malformed json/);
	});
});
