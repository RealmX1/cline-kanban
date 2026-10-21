import { describe, expect, it, vi } from "vitest";
import {
	joinPcmWavSegmentsWithSilenceGap,
	readPcmWavSegment,
} from "../../src/notifications/notification-speech-pcm-wav-segment-join";

// 与合成侧 MAX_AUDIO_BYTES 同值，模拟调用方传入的音频大小上限。
const SYNTHESIS_SIDE_MAXIMUM_AUDIO_BYTE_LENGTH = 12 * 1024 * 1024;

function pcmWav(
	samples: number[],
	options: {
		sampleRate?: number;
		streamingPlaceholderLengths?: boolean;
		extraChunkBeforeData?: boolean;
		fmtFieldOverrides?: { audioFormat?: number; channelCount?: number; blockAlign?: number; bitsPerSample?: number };
	} = {},
) {
	const sampleRate = options.sampleRate ?? 24_000;
	const pcm = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => {
		pcm.writeInt16LE(sample, index * 2);
	});
	const fmt = Buffer.alloc(24);
	fmt.write("fmt ", 0, "ascii");
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(options.fmtFieldOverrides?.audioFormat ?? 1, 8);
	fmt.writeUInt16LE(options.fmtFieldOverrides?.channelCount ?? 1, 10);
	fmt.writeUInt32LE(sampleRate, 12);
	fmt.writeUInt32LE(sampleRate * 2, 16);
	fmt.writeUInt16LE(options.fmtFieldOverrides?.blockAlign ?? 2, 20);
	fmt.writeUInt16LE(options.fmtFieldOverrides?.bitsPerSample ?? 16, 22);
	const list = Buffer.from("LIST\u0003\u0000\u0000\u0000abc\u0000", "latin1");
	const dataHeader = Buffer.alloc(8);
	dataHeader.write("data", 0, "ascii");
	// DashScope qwen3-tts 流式 WAV 的真实占位长度。
	dataHeader.writeUInt32LE(options.streamingPlaceholderLengths ? 0x7fffff9b : pcm.length, 4);
	const riff = Buffer.alloc(12);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(options.streamingPlaceholderLengths ? 0x7fffffbf : 0, 4);
	riff.write("WAVE", 8, "ascii");
	return Buffer.concat([riff, fmt, ...(options.extraChunkBeforeData ? [list] : []), dataHeader, pcm]);
}

function expectJoinRejectedBeforeAnyAllocation(segments: Buffer[], silenceGapMilliseconds: number, message: string) {
	const allocationSpy = vi.spyOn(Buffer, "alloc");
	try {
		expect(() =>
			joinPcmWavSegmentsWithSilenceGap(segments, silenceGapMilliseconds, SYNTHESIS_SIDE_MAXIMUM_AUDIO_BYTE_LENGTH),
		).toThrow(message);
		expect(allocationSpy).not.toHaveBeenCalled();
	} finally {
		allocationSpy.mockRestore();
	}
}

describe("PCM WAV 分段拼接", () => {
	it("流式 WAV 的占位长度按实际字节截取，段间插入精确静音", () => {
		const leadIn = pcmWav([100, 200, 300], { streamingPlaceholderLengths: true });
		const body = pcmWav([-5, 7], { extraChunkBeforeData: true });
		const joined = joinPcmWavSegmentsWithSilenceGap([leadIn, body], 1000, SYNTHESIS_SIDE_MAXIMUM_AUDIO_BYTE_LENGTH);
		const { format, pcmSampleBytes } = readPcmWavSegment(joined);
		expect(format).toMatchObject({ sampleRate: 24_000, channelCount: 1, bitsPerSample: 16 });
		expect(joined.readUInt32LE(4)).toBe(joined.length - 8);
		const samples = Array.from({ length: pcmSampleBytes.length / 2 }, (_, index) =>
			pcmSampleBytes.readInt16LE(index * 2),
		);
		expect(samples).toHaveLength(3 + 24_000 + 2);
		expect(samples.slice(0, 3)).toEqual([100, 200, 300]);
		expect(samples.slice(3, 3 + 24_000).every((sample) => sample === 0)).toBe(true);
		expect(samples.slice(-2)).toEqual([-5, 7]);
	});

	it("采样格式不一致或不是 WAV 时拒绝拼接", () => {
		expect(() =>
			joinPcmWavSegmentsWithSilenceGap(
				[pcmWav([1]), pcmWav([1], { sampleRate: 16_000 })],
				100,
				SYNTHESIS_SIDE_MAXIMUM_AUDIO_BYTE_LENGTH,
			),
		).toThrow("采样格式不一致");
		expect(() =>
			joinPcmWavSegmentsWithSilenceGap(
				[pcmWav([1]), Buffer.from("ID3mp3-payload")],
				100,
				SYNTHESIS_SIDE_MAXIMUM_AUDIO_BYTE_LENGTH,
			),
		).toThrow("不是 WAV");
	});

	it("fmt 值域异常的 provider 回包在分配静音缓冲之前就被拒绝", () => {
		// 评审复现：sampleRate=2000000、blockAlign=8、bitsPerSample=64 的整数 PCM。
		const reviewReproductionFmt = {
			sampleRate: 2_000_000,
			fmtFieldOverrides: { blockAlign: 8, bitsPerSample: 64 },
		};
		expectJoinRejectedBeforeAnyAllocation(
			[pcmWav([1], reviewReproductionFmt), pcmWav([1], reviewReproductionFmt)],
			1200,
			"位深不受支持",
		);
		const oversizedSampleRate = { sampleRate: 2_000_000 };
		expectJoinRejectedBeforeAnyAllocation(
			[pcmWav([1], oversizedSampleRate), pcmWav([1], oversizedSampleRate)],
			1200,
			"采样率超出支持范围",
		);
		const inflatedBlockAlign = { fmtFieldOverrides: { blockAlign: 0xffff } };
		expectJoinRejectedBeforeAnyAllocation(
			[pcmWav([1], inflatedBlockAlign), pcmWav([1], inflatedBlockAlign)],
			1200,
			"帧长与声道数、位深不一致",
		);
		const absurdChannelCount = { fmtFieldOverrides: { channelCount: 4096, blockAlign: 8192 } };
		expectJoinRejectedBeforeAnyAllocation(
			[pcmWav([1], absurdChannelCount), pcmWav([1], absurdChannelCount)],
			1200,
			"声道数超出支持范围",
		);
		const compressedAudioFormat = { fmtFieldOverrides: { audioFormat: 0x55 } };
		expectJoinRejectedBeforeAnyAllocation([pcmWav([1], compressedAudioFormat)], 1200, "只支持未压缩的 PCM WAV");
	});

	it("预计输出超过调用方上限时在分配之前拒绝，恰好等于上限时照常拼接", () => {
		const leadIn = pcmWav([100, 200, 300]);
		const body = pcmWav([-5, 7]);
		// 44 字节头 + 3 帧 + 1 秒静音（24000 帧）+ 2 帧，每帧 2 字节。
		const exactJoinedWavByteLength = 44 + (3 + 24_000 + 2) * 2;
		const allocationSpy = vi.spyOn(Buffer, "alloc");
		try {
			expect(() => joinPcmWavSegmentsWithSilenceGap([leadIn, body], 1000, exactJoinedWavByteLength - 1)).toThrow(
				"拼接后的音频超过大小限制",
			);
			expect(allocationSpy).not.toHaveBeenCalled();
		} finally {
			allocationSpy.mockRestore();
		}
		expect(joinPcmWavSegmentsWithSilenceGap([leadIn, body], 1000, exactJoinedWavByteLength)).toHaveLength(
			exactJoinedWavByteLength,
		);
		// 值域内的最大格式（192kHz / 8 声道 / 64 位浮点）每秒约 12.3MB：1.2 秒停顿就超过 12 MiB，同样在分配前拒绝。
		const largestSupportedFormat = {
			sampleRate: 192_000,
			fmtFieldOverrides: { audioFormat: 3, channelCount: 8, blockAlign: 64, bitsPerSample: 64 },
		};
		expectJoinRejectedBeforeAnyAllocation(
			[pcmWav([], largestSupportedFormat), pcmWav([], largestSupportedFormat)],
			1200,
			"拼接后的音频超过大小限制",
		);
	});
});
