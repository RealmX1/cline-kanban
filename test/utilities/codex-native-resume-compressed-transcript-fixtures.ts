import { readFileSync } from "node:fs";

// 使用 Node zstdCompressSync 生成固定样本，使 Node 22.0 也能测试真实压缩数据。
export const compressedCodexTranscriptFixtureNativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";

export const compressedCodexTranscriptFixtureBase64ByScenario = {
	"persistent-main":
		"KLUv/SB72QMAeyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6IjAxYTE1MTIwLTQ0NzYtNzhiMC04YzU2LTVhNzMyMTMzOGUwYiIsInNvdXJjZSI6ImNsaSJ9fQrlkI7nu63mraPmlofkuI3mmK/lhYPmlbDmja4K",
	"wrong-identity":
		"KLUv/SBpSQMAeyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6Im90aGVyLWNvbnZlcnNhdGlvbiIsInNvdXJjZSI6ImNsaSJ9fQrlkI7nu63mraPmlofkuI3mmK/lhYPmlbDmja4K",
	"wrong-session-id":
		"KLUv/SCd6QQAeyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6IjAxYTE1MTIwLTQ0NzYtNzhiMC04YzU2LTVhNzMyMTMzOGUwYiIsInNvdXJjZSI6ImNsaSIsInNlc3Npb25faWQiOiJvdGhlci1jb252ZXJzYXRpb24ifX0K5ZCO57ut5q2j5paH5LiN5piv5YWD5pWw5o2uCg==",
	subagent:
		"KLUv/SCxBQUA8ogiJ5BZB+LdXZTx8cy3LdZuEeKSCSLkJMWqv8IdzUyVu2TbJgTE5GRWAsvju5HFNRxCSON+EgqCcR3gBSeVhCJcClxZ6ltXSuj6Fda+BaylDmiLe782Tntm2JI+Oc5sHKmhGEHXFKU1STGSnifKZkKzp2SKsYw9irHWBF1XZritDyqqZf/+TLHXzrIXBwC4gDYTI75AZ5qZll6Mq2ypMw==",
	internal:
		"KLUv/SCxHQUA5Ah7InR5cGUiOiJzZXNzaW9uX21ldGEiLCJwYXlsb2FkIjp7ImlkIjoiMDFhMTUxMjAtNDQ3Ni03OGIwLThjNTYtNWE3MzIxMzM4ZTBiIiwic291cmNlbnRlcm5hbHRocmVhZF9zcGF3bnBhcmVudF8ifQrlkI7nu63mraPmlofkuI3mmK/lhYPmlbDmja4KBwC4gDYTI75AZ5qZll7MqtwqMw==",
	memory_consolidation:
		"KLUv/SCMYQQAeyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6IjAxYTE1MTIwLTQ0NzYtNzhiMC04YzU2LTVhNzMyMTMzOGUwYiIsInNvdXJjZSI6Im1lbW9yeV9jb25zb2xpZGF0aW9uIn19CuWQjue7reato+aWh+S4jeaYr+WFg+aVsOaNrgo=",
	guardian_review:
		"KLUv/SCHOQQAeyJ0eXBlIjoic2Vzc2lvbl9tZXRhIiwicGF5bG9hZCI6eyJpZCI6IjAxYTE1MTIwLTQ0NzYtNzhiMC04YzU2LTVhNzMyMTMzOGUwYiIsInNvdXJjZSI6Imd1YXJkaWFuX3JldmlldyJ9fQrlkI7nu63mraPmlofkuI3mmK/lhYPmlbDmja4K",
	"malformed-tail":
		"KLUv/SBp9QIAkoYWGXDFOnBRb6VtUAKnrcT0//v2i34oharPVUQCfH2fgydK0zgiz85/AkVSDz7Qm1KJUGzXMdZrBx2NHYMVxUFEWmkTsjOMZpzhSmTZ6cFbHwAkMlJ6aufPpZoJAA==",
	"missing-newline":
		"KLUv/SBetQIA4oUUGYDFbXgpfjhqMUwtumDInI3SE+iVc7BBc0dN84aw75sJBu793MheCKmAFCckEluYxlJIqGHAFDQpa35/tDP7gx2ycPJzVhpQBFx7r9/3nSzKmQA=",
	"large-chinese-metadata":
		"KLUv/aDPABQAPAIA1AN7InBheWxvYWQiOnsiYmFzZV9pbnN0cnVjdGlvbnMiOnsidGV4dCI6IuS4reaWh+ivtOaYjlxuXHRcIlxcAQAN/H/5hAJMAAAIjgEA/P85EAJMAAAI5gEA/P85EAJMAAAIdAEA/P85EAJMAAAIrwEA/P85EAJMAAAIXAEA/P85EAJMAAAIjgEA/P85EAJMAAAI5gEA/P85EAJMAAAIdAEA/P85EAJMAAAIrwEA/P85EAINBABEB1wifSwiaWQiOiIwMWExNTEyMC00NDc2LTc4YjAtOGM1Ni01YTczMjEzMzhlMGIiLCJzb3VyY2UiOiJjbGkiLCJzZXNzaW9uX30sInR5cGUiOm1ldGEifQrlkI7nu63mraPmlofkuI3mmK/lhYPmlbDmja4KAwBfizsaATJLIAQ=",
	"metadata-on-second-line":
		"KLUv/SBi1QIAIoYVGoDFOrQofgwiMXwJSMGQOUz7C/IRIrhBjXsCQoxvCvt6M8HAvQ9HtNU5S5zEKA3EVCqiUhqpKFKJRcurX0/a4XrCTml4+XBmGnAEXHuv39d7aZhDIcIA",
	"valid-multi-block":
		"KLUv/aDfTxIArAMAtAZ7InR5cGUiOiJzZXNzaW9uX21ldGEiLCJwYXlsb2FkIjp7ImlkIjoiMDFhMTUxMjAtNDQ3Ni03OGIwLThjNTYtNWE3MzIxMzM4ZTBiIiwic291cmNlIjoiY2xpIn19CuWQjue7reato+aWhwEAq+T/8xIFTAAACOYBAPz/ORACTAAACK0BAPz/ORACTAAACJABAPz/ORACTAAACOYBAPz/ORACTAAACK0BAPz/ORACTAAACJABAPz/ORACTAAACOYBAPz/ORACTAAACK0BAPz/ORACRQAACJABANvPDoQ=",
	"truncated-after-metadata-block":
		"KLUv/aDfTxIArAMAtAZ7InR5cGUiOiJzZXNzaW9uX21ldGEiLCJwYXlsb2FkIjp7ImlkIjoiMDFhMTUxMjAtNDQ3Ni03OGIwLThjNTYtNWE3MzIxMzM4ZTBiIiwic291cmNlIjoiY2xpIn19CuWQjue7reato+aWhwEAq+T/8xIF",
	"short-final-frame":
		"KLUv/SBetQIA4oUUGYDFbXgpfjhqMUwtumDInI3SE+iVc7BBc0dN84aw75sJBu793MheCKmAFCckEluYxlJIqGHAFDQpa35/tDP7gx2ycPJzVhpQBFx7r9/3nSzKmQAotS/9IAEJAAAK",
	"valid-rle-frame":
		"KLUv/SBfxQIA8gUVGnDHbZAfXwEpSsJFF0z/v3zpCfSO8lL6saYIgKZ5Q9j3zQgF935uZC+EdECKExaJLUxjKSwUQWAOmpQ1vz/amf3BDlk4+TkrLQgMXHuv3/edLMqZACi1L/0gFKMAAAo=",
	"invalid-checksum":
		"KLUv/SRfxQIA8gUVGnDHbZAfXwEpSsJFF0z/v3zpCfSO8lL6saYIgKZ5Q9j3zQgF935uZC+EdECKExaJLUxjKSwUQWAOmpQ1vz/amf3BDlk4+TkrLQgMXHuv3/edLMqZAN3Q1zc=",
} as const;

export function compressedCodexTranscriptFixtureBytes(
	scenario:
		| keyof typeof compressedCodexTranscriptFixtureBase64ByScenario
		| "valid-long-distance-metadata" = "persistent-main",
): Buffer {
	if (scenario === "valid-long-distance-metadata") {
		return readFileSync(
			new URL(
				"../fixtures/codex-native-compressed-transcript-with-long-distance-metadata.jsonl.zst",
				import.meta.url,
			),
		);
	}
	return Buffer.from(compressedCodexTranscriptFixtureBase64ByScenario[scenario], "base64");
}
