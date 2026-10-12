// runtime（controller）与 agent session PTY host 之间 Unix socket 上的帧编解码。
//
// 帧格式：`u32 BE payload 字节数 | u8 帧类型 | payload`。
// - json_control_message：payload 是 UTF-8 JSON（控制消息，见 agent-session-pty-host-wire-protocol-messages.ts）。
// - hosted_session_output_bytes（host → controller）：`u32 BE 会话通道号 | u64 BE 本段首字节的绝对偏移 | 原始字节`。
//   绝对偏移从会话 spawn 起累计，接收方据此判断有没有缺段 / 重复，跨 controller 重连也成立。
// - hosted_session_input_bytes（controller → host）：`u32 BE 会话通道号 | 原始字节`。
// PTY 字节走二进制帧而不是 JSON：输出是热路径，base64 会多 33% 体积与一次编解码。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`（host bundle 的 import 守卫会检查）。

export const AGENT_SESSION_PTY_HOST_WIRE_FRAME_HEADER_BYTE_LENGTH = 5;
// 单帧上限。PTY 单次 read 通常 ≤ 64 KiB；host 侧把追赶重放切成小段发送，这个上限只用来拒绝损坏的长度字段，
// 避免一个坏帧让接收方无限攒缓冲。
export const AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH = 16 * 1024 * 1024;

export const AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES = {
	json_control_message: 1,
	hosted_session_output_bytes: 2,
	hosted_session_input_bytes: 3,
} as const;

const HOSTED_SESSION_OUTPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH = 4 + 8;
const HOSTED_SESSION_INPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH = 4;

export type DecodedAgentSessionPtyHostWireFrame =
	| { kind: "json_control_message"; message: unknown }
	| {
			kind: "hosted_session_output_bytes";
			hostedSessionChannelNumber: number;
			startByteOffset: number;
			bytes: Buffer;
	  }
	| { kind: "hosted_session_input_bytes"; hostedSessionChannelNumber: number; bytes: Buffer };

export class AgentSessionPtyHostWireFrameDecodingError extends Error {}

function encodeFrame(frameKindCode: number, payload: Buffer): Buffer {
	if (payload.byteLength > AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH) {
		throw new AgentSessionPtyHostWireFrameDecodingError(
			`agent session pty host wire frame payload too large: ${payload.byteLength} bytes`,
		);
	}
	const header = Buffer.allocUnsafe(AGENT_SESSION_PTY_HOST_WIRE_FRAME_HEADER_BYTE_LENGTH);
	header.writeUInt32BE(payload.byteLength, 0);
	header.writeUInt8(frameKindCode, 4);
	return Buffer.concat([header, payload]);
}

export function encodeJsonControlMessageFrame(message: unknown): Buffer {
	return encodeFrame(
		AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.json_control_message,
		Buffer.from(JSON.stringify(message), "utf8"),
	);
}

export function encodeHostedSessionOutputBytesFrame(
	hostedSessionChannelNumber: number,
	startByteOffset: number,
	bytes: Buffer,
): Buffer {
	const prefix = Buffer.allocUnsafe(HOSTED_SESSION_OUTPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH);
	prefix.writeUInt32BE(hostedSessionChannelNumber, 0);
	prefix.writeBigUInt64BE(BigInt(startByteOffset), 4);
	return encodeFrame(
		AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.hosted_session_output_bytes,
		Buffer.concat([prefix, bytes]),
	);
}

export function encodeHostedSessionInputBytesFrame(hostedSessionChannelNumber: number, bytes: Buffer): Buffer {
	const prefix = Buffer.allocUnsafe(HOSTED_SESSION_INPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH);
	prefix.writeUInt32BE(hostedSessionChannelNumber, 0);
	return encodeFrame(
		AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.hosted_session_input_bytes,
		Buffer.concat([prefix, bytes]),
	);
}

function decodeFramePayload(frameKindCode: number, payload: Buffer): DecodedAgentSessionPtyHostWireFrame {
	switch (frameKindCode) {
		case AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.json_control_message: {
			try {
				return { kind: "json_control_message", message: JSON.parse(payload.toString("utf8")) };
			} catch (error) {
				throw new AgentSessionPtyHostWireFrameDecodingError(
					`malformed json control message frame: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		case AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.hosted_session_output_bytes: {
			if (payload.byteLength < HOSTED_SESSION_OUTPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH) {
				throw new AgentSessionPtyHostWireFrameDecodingError("truncated hosted session output bytes frame");
			}
			return {
				kind: "hosted_session_output_bytes",
				hostedSessionChannelNumber: payload.readUInt32BE(0),
				startByteOffset: Number(payload.readBigUInt64BE(4)),
				bytes: payload.subarray(HOSTED_SESSION_OUTPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH),
			};
		}
		case AGENT_SESSION_PTY_HOST_WIRE_FRAME_KIND_CODES.hosted_session_input_bytes: {
			if (payload.byteLength < HOSTED_SESSION_INPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH) {
				throw new AgentSessionPtyHostWireFrameDecodingError("truncated hosted session input bytes frame");
			}
			return {
				kind: "hosted_session_input_bytes",
				hostedSessionChannelNumber: payload.readUInt32BE(0),
				bytes: payload.subarray(HOSTED_SESSION_INPUT_BYTES_FRAME_PREFIX_BYTE_LENGTH),
			};
		}
		default:
			throw new AgentSessionPtyHostWireFrameDecodingError(`unknown wire frame kind code ${frameKindCode}`);
	}
}

// 流式解码器：socket 的 data 事件可能在任意字节处切开帧，也可能一次带来多帧。
// 解码出错（长度超限 / 未知类型 / JSON 损坏）时抛出，调用方应当断开这条连接：之后的字节边界已不可信。
export class AgentSessionPtyHostWireFrameDecoder {
	private bufferedBytes: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): DecodedAgentSessionPtyHostWireFrame[] {
		this.bufferedBytes = this.bufferedBytes.byteLength === 0 ? chunk : Buffer.concat([this.bufferedBytes, chunk]);
		const decodedFrames: DecodedAgentSessionPtyHostWireFrame[] = [];
		while (this.bufferedBytes.byteLength >= AGENT_SESSION_PTY_HOST_WIRE_FRAME_HEADER_BYTE_LENGTH) {
			const payloadByteLength = this.bufferedBytes.readUInt32BE(0);
			if (payloadByteLength > AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH) {
				throw new AgentSessionPtyHostWireFrameDecodingError(
					`wire frame payload length ${payloadByteLength} exceeds maximum`,
				);
			}
			const frameByteLength = AGENT_SESSION_PTY_HOST_WIRE_FRAME_HEADER_BYTE_LENGTH + payloadByteLength;
			if (this.bufferedBytes.byteLength < frameByteLength) {
				break;
			}
			const frameKindCode = this.bufferedBytes.readUInt8(4);
			// 复制出 payload：bufferedBytes 之后会被切片复用，二进制帧的 bytes 交给调用方长期持有。
			const payload = Buffer.from(
				this.bufferedBytes.subarray(AGENT_SESSION_PTY_HOST_WIRE_FRAME_HEADER_BYTE_LENGTH, frameByteLength),
			);
			this.bufferedBytes = this.bufferedBytes.subarray(frameByteLength);
			decodedFrames.push(decodeFramePayload(frameKindCode, payload));
		}
		return decodedFrames;
	}
}
