// 把多段 PCM WAV 按顺序拼成一段，段间插入静音：通知播报「先导 → 停顿 → 正文」的停顿就是在这里插入的。
// 不用 SSML <break>：qwen3-tts-flash 与 Kokoro 不支持，qwen-audio 内置音色是否支持也没有官方确认；分段拼接对所有 provider 一致可用。
// 注意：DashScope qwen3-tts 返回的是流式 WAV，RIFF 与 data 的长度字段都是占位值（实测 0x7FFFFF9B），
// 所以 data 长度一律以实际剩余字节为准，不信任头里的长度。
// 评估过的替代：wavefile 包自 2020 年后未维护，且同样需要自己处理流式头，不引入。

interface PcmWavSegmentFormat {
	audioFormat: number;
	channelCount: number;
	sampleRate: number;
	bitsPerSample: number;
	blockAlign: number;
}

const WAVE_FORMAT_PCM_INTEGER = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const PCM_WAV_CANONICAL_HEADER_BYTE_LENGTH = 44;
// fmt 字段来自第三方 TTS 回包，后续静音缓冲按它分配，必须先校验值域；真实 provider 返回 24000Hz / 16 位 / 单声道。
const SUPPORTED_BITS_PER_SAMPLE_BY_WAVE_FORMAT: ReadonlyMap<number, readonly number[]> = new Map([
	[WAVE_FORMAT_PCM_INTEGER, [8, 16, 24, 32]],
	[WAVE_FORMAT_IEEE_FLOAT, [32, 64]],
]);
const MINIMUM_SUPPORTED_PCM_WAV_SAMPLE_RATE_HERTZ = 8_000;
const MAXIMUM_SUPPORTED_PCM_WAV_SAMPLE_RATE_HERTZ = 192_000;
const MAXIMUM_SUPPORTED_PCM_WAV_CHANNEL_COUNT = 8;

function assertPcmWavSegmentFormatWithinSupportedRange(format: PcmWavSegmentFormat): void {
	const supportedBitsPerSample = SUPPORTED_BITS_PER_SAMPLE_BY_WAVE_FORMAT.get(format.audioFormat);
	if (!supportedBitsPerSample) throw new Error("只支持未压缩的 PCM WAV");
	if (!supportedBitsPerSample.includes(format.bitsPerSample)) throw new Error("WAV 位深不受支持");
	if (format.channelCount < 1 || format.channelCount > MAXIMUM_SUPPORTED_PCM_WAV_CHANNEL_COUNT)
		throw new Error("WAV 声道数超出支持范围");
	if (
		format.sampleRate < MINIMUM_SUPPORTED_PCM_WAV_SAMPLE_RATE_HERTZ ||
		format.sampleRate > MAXIMUM_SUPPORTED_PCM_WAV_SAMPLE_RATE_HERTZ
	)
		throw new Error("WAV 采样率超出支持范围");
	if (format.blockAlign !== (format.channelCount * format.bitsPerSample) / 8)
		throw new Error("WAV 帧长与声道数、位深不一致");
}

export function readPcmWavSegment(bytes: Buffer): { format: PcmWavSegmentFormat; pcmSampleBytes: Buffer } {
	if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
		throw new Error("音频片段不是 WAV");
	let format: PcmWavSegmentFormat | null = null;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = bytes.toString("ascii", offset, offset + 4);
		const declaredChunkSize = bytes.readUInt32LE(offset + 4);
		const chunkBodyStart = offset + 8;
		if (chunkId === "fmt ") {
			if (chunkBodyStart + 16 > bytes.length) throw new Error("WAV fmt 块不完整");
			format = {
				audioFormat: bytes.readUInt16LE(chunkBodyStart),
				channelCount: bytes.readUInt16LE(chunkBodyStart + 2),
				sampleRate: bytes.readUInt32LE(chunkBodyStart + 4),
				blockAlign: bytes.readUInt16LE(chunkBodyStart + 12),
				bitsPerSample: bytes.readUInt16LE(chunkBodyStart + 14),
			};
		} else if (chunkId === "data") {
			if (!format) throw new Error("WAV 缺少 fmt 块");
			assertPcmWavSegmentFormatWithinSupportedRange(format);
			const availableBytes = Math.min(declaredChunkSize, bytes.length - chunkBodyStart);
			const wholeFrameBytes = availableBytes - (availableBytes % format.blockAlign);
			return { format, pcmSampleBytes: bytes.subarray(chunkBodyStart, chunkBodyStart + wholeFrameBytes) };
		}
		offset = chunkBodyStart + declaredChunkSize + (declaredChunkSize % 2);
	}
	throw new Error("WAV 缺少 data 块");
}

function isSameSampleFormat(left: PcmWavSegmentFormat, right: PcmWavSegmentFormat): boolean {
	return (
		left.audioFormat === right.audioFormat &&
		left.channelCount === right.channelCount &&
		left.sampleRate === right.sampleRate &&
		left.bitsPerSample === right.bitsPerSample &&
		left.blockAlign === right.blockAlign
	);
}

// maximumJoinedWavByteLength 由调用方传入它自己的音频大小上限：超限在任何分配之前就拒绝，而不是拼完再查。
export function joinPcmWavSegmentsWithSilenceGap(
	segments: Buffer[],
	silenceGapMilliseconds: number,
	maximumJoinedWavByteLength: number,
): Buffer {
	const parsedSegments = segments.map(readPcmWavSegment);
	const format = parsedSegments[0]?.format;
	if (!format) throw new Error("没有可拼接的音频片段");
	if (parsedSegments.some((segment) => !isSameSampleFormat(segment.format, format)))
		throw new Error("音频片段的采样格式不一致，无法拼接");
	const silenceFrameCount = Math.round((format.sampleRate * Math.max(0, silenceGapMilliseconds)) / 1000);
	const silenceByteLength = silenceFrameCount * format.blockAlign;
	const projectedPcmByteLength =
		parsedSegments.reduce((total, segment) => total + segment.pcmSampleBytes.length, 0) +
		silenceByteLength * (parsedSegments.length - 1);
	if (PCM_WAV_CANONICAL_HEADER_BYTE_LENGTH + projectedPcmByteLength > maximumJoinedWavByteLength)
		throw new Error("拼接后的音频超过大小限制");
	// 8 位 PCM 是无符号的，静音值为 0x80；其它位深静音为 0。
	const silence = Buffer.alloc(
		silenceByteLength,
		format.audioFormat === WAVE_FORMAT_PCM_INTEGER && format.bitsPerSample === 8 ? 0x80 : 0,
	);
	const pcmParts = parsedSegments.flatMap((segment, index) =>
		index === 0 ? [segment.pcmSampleBytes] : [silence, segment.pcmSampleBytes],
	);
	const pcmByteLength = pcmParts.reduce((total, part) => total + part.length, 0);
	const header = Buffer.alloc(PCM_WAV_CANONICAL_HEADER_BYTE_LENGTH);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcmByteLength, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(format.audioFormat, 20);
	header.writeUInt16LE(format.channelCount, 22);
	header.writeUInt32LE(format.sampleRate, 24);
	header.writeUInt32LE(format.sampleRate * format.blockAlign, 28);
	header.writeUInt16LE(format.blockAlign, 32);
	header.writeUInt16LE(format.bitsPerSample, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcmByteLength, 40);
	return Buffer.concat([header, ...pcmParts]);
}
