import { describe, expect, it } from "vitest";
import { createCodexAppServerLfDelimitedUtf8ResponseDecoder } from "../../../src/rvf-automatic-closeout/codex-app-server-lf-delimited-utf8-response-decoder";

describe("Codex LF 响应分帧", () => {
	it("在每一个 UTF-8 字节切点保留 Unicode 分隔符和文本", () => {
		const expectedFrame = JSON.stringify({ text: "中文😀前\u2028中\u2029后" });
		const bytes = Buffer.from(`${expectedFrame}\n`);
		for (let split = 0; split <= bytes.length; split++) {
			const frames: string[] = [];
			const decoder = createCodexAppServerLfDelimitedUtf8ResponseDecoder((frame) => frames.push(frame));
			decoder.write(bytes.subarray(0, split));
			decoder.write(bytes.subarray(split));
			decoder.end();
			expect(frames).toEqual([expectedFrame]);
		}
	});
	it("处理跨 chunk CRLF、多帧和 EOF 无换行尾帧", () => {
		const frames: string[] = [];
		const decoder = createCodexAppServerLfDelimitedUtf8ResponseDecoder((frame) => frames.push(frame));
		decoder.write(Buffer.from('{"id":1}\r'));
		decoder.write(Buffer.from('\n\r\n{"id":2}\n{"id":'));
		expect(frames).toEqual(['{"id":1}', "", '{"id":2}']);
		decoder.write(Buffer.from("3}"));
		decoder.end();
		expect(frames).toEqual(['{"id":1}', "", '{"id":2}', '{"id":3}']);
	});
});
