import { createHash } from "node:crypto";
import type { RuntimePostDeployVerificationChecklistItem } from "../core/api-contract";

// 指纹只包含核对依据；label、定位和清理文案不改变断言。资产完整版本化不在本次范围。
export function verificationExecutionDefinitionFingerprint(item: RuntimePostDeployVerificationChecklistItem): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: item.kind,
				script:
					item.script === null
						? null
						: {
								entrypoint: item.script.entrypoint,
								interpreter: item.script.interpreter,
								timeoutMs: item.script.timeoutMs,
							},
				steps: item.guidance?.steps ?? null,
				expectedObservation: item.guidance?.expectedObservation ?? null,
			}),
		)
		.digest("hex");
}
