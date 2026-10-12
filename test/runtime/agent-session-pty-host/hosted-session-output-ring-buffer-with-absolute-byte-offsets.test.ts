import { describe, expect, it } from "vitest";
import { HostedSessionOutputRingBufferWithAbsoluteByteOffsets } from "../../../src/agent-session-pty-host/host-process/hosted-session-output-ring-buffer-with-absolute-byte-offsets";

function bytesOf(text: string): Buffer {
	return Buffer.from(text, "utf8");
}

describe("HostedSessionOutputRingBufferWithAbsoluteByteOffsets", () => {
	it("returns every appended byte with absolute offsets while under capacity", () => {
		const ringBuffer = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(16);

		expect(ringBuffer.append(bytesOf("hello "))).toBe(0);
		expect(ringBuffer.append(bytesOf("world"))).toBe(6);

		const fromStart = ringBuffer.readFromAbsoluteByteOffset(0);
		expect(fromStart.bytes.toString("utf8")).toBe("hello world");
		expect(fromStart.startByteOffset).toBe(0);
		expect(fromStart.overwrittenByteCountBeforeStart).toBe(0);
		expect(ringBuffer.readFromAbsoluteByteOffset(6).bytes.toString("utf8")).toBe("world");
		expect(ringBuffer.readFromAbsoluteByteOffset(11).bytes.byteLength).toBe(0);
	});

	it("wraps around and reports how many requested bytes were overwritten", () => {
		const ringBuffer = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(8);
		ringBuffer.append(bytesOf("abcdef"));
		ringBuffer.append(bytesOf("ghijk"));

		expect(ringBuffer.endByteOffset).toBe(11);
		expect(ringBuffer.retainedStartByteOffset).toBe(3);
		const result = ringBuffer.readFromAbsoluteByteOffset(0);
		expect(result.bytes.toString("utf8")).toBe("defghijk");
		expect(result.startByteOffset).toBe(3);
		expect(result.overwrittenByteCountBeforeStart).toBe(3);
		expect(ringBuffer.readFromAbsoluteByteOffset(9).bytes.toString("utf8")).toBe("jk");
	});

	it("keeps only the tail of a single append larger than the capacity while advancing offsets by the full length", () => {
		const ringBuffer = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(4);
		ringBuffer.append(bytesOf("xy"));

		expect(ringBuffer.append(bytesOf("0123456789"))).toBe(2);
		expect(ringBuffer.endByteOffset).toBe(12);
		const result = ringBuffer.readFromAbsoluteByteOffset(0);
		expect(result.bytes.toString("utf8")).toBe("6789");
		expect(result.startByteOffset).toBe(8);
	});

	it("matches a byte-for-byte reference model across many small appends", () => {
		const ringBuffer = new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(37);
		let referenceText = "";
		for (let appendIndex = 0; appendIndex < 200; appendIndex += 1) {
			const piece = `${appendIndex}:${"z".repeat(appendIndex % 7)};`;
			ringBuffer.append(bytesOf(piece));
			referenceText += piece;
			const requestedOffset = Math.max(0, referenceText.length - 50);
			const result = ringBuffer.readFromAbsoluteByteOffset(requestedOffset);
			expect(result.bytes.toString("utf8")).toBe(referenceText.slice(result.startByteOffset));
			expect(result.startByteOffset).toBe(Math.max(requestedOffset, referenceText.length - 37));
		}
	});
});
