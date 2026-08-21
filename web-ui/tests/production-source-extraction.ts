/**
 * 把生产源码里的函数与常量**逐字**取出，供 Playwright 合成页注入。
 *
 * 合成页不连接 runtime，靠的是复刻；复刻一旦成了「照着写一遍」，判定口径就会与生产悄悄分叉，
 * 用例还照绿。所以这里只做文本抽取与 TS 注解摘除，绝不重写逻辑。
 */

export function extractFunctionSource(source: string, functionName: string): string {
	const start = source.indexOf(`function ${functionName}(`);
	if (start === -1) {
		throw new Error(`Could not find function "${functionName}".`);
	}
	const bodyStart = source.indexOf("{", start);
	if (bodyStart === -1) {
		throw new Error(`Malformed function "${functionName}".`);
	}
	let depth = 0;
	for (let index = bodyStart; index < source.length; index += 1) {
		if (source[index] === "{") {
			depth += 1;
		} else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(start, index + 1);
			}
		}
	}
	throw new Error(`Unterminated function "${functionName}".`);
}

export function extractConstantSource(source: string, constantName: string): string {
	const declaration = `const ${constantName} =`;
	const start = source.indexOf(declaration);
	if (start === -1) {
		throw new Error(`Could not find constant "${constantName}".`);
	}
	const end = source.indexOf(";", start);
	if (end === -1) {
		throw new Error(`Unterminated constant "${constantName}".`);
	}
	return source.slice(start, end + 1);
}

/**
 * 把源码里所有 `useHotkeys("...")` 的**热键声明字符串**逐字取出（按出现顺序）。
 *
 * 合成页要判断「这个按键到底会不会触发热键」，就必须知道生产究竟声明了哪些修饰键。把声明写死在
 * 合成页里等于又造一份副本：生产改成 `shift+alt+up` 而合成页仍按 `alt+up` 判定时，用例照绿。
 */
export function extractUseHotkeysDeclarationStrings(source: string): string[] {
	const declarations: string[] = [];
	const callPattern = /useHotkeys\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
	for (const match of source.matchAll(callPattern)) {
		declarations.push(match[2] as string);
	}
	if (declarations.length === 0) {
		throw new Error("Could not find any useHotkeys declaration string.");
	}
	return declarations;
}

/**
 * 合成页里跑的是纯 JS：摘掉**签名**里的形参与返回值类型注解，函数体逐字保留。
 *
 * 只在签名段（`function 名(` 起、到函数体左花括号止）动手，绝不对函数体做正则：函数体里的对象
 * 字面量同样长成 `键: 值`，全文替换会把它们一起删掉。
 *
 * 两条前提（被抽取的函数不满足时应改函数，而不是放宽这里）：形参不得使用解构（`{ a, b }` 里的
 * 左花括号会被误当成函数体起点），类型注解里不得出现逗号（`Map<string, number>` 会被截断）。
 */
export function stripTypeAnnotations(functionSource: string): string {
	const bodyStart = functionSource.indexOf("{");
	if (bodyStart === -1) {
		throw new Error("Malformed function source: no function body found.");
	}
	// `: 类型` 一直吃到下一个逗号或右括号为止 —— 形参注解与返回值注解都落在这一条规则里。
	const signatureWithoutTypeAnnotations = functionSource.slice(0, bodyStart).replace(/:\s*[^,)]+/g, "");
	return `${signatureWithoutTypeAnnotations}${functionSource.slice(bodyStart)}`;
}
