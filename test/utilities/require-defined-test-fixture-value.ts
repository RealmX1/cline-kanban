import assert from "node:assert/strict";

export function requireDefinedTestFixtureValue<Value>(value: Value | null | undefined): Value {
	assert.ok(value !== undefined && value !== null, "测试 fixture 缺少必需值。");
	return value;
}
