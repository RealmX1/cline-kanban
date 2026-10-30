// 仅拆分 argv；不执行变量、命令、通配符或 shell 运算符展开。
export function parseAdditionalAgentStartupArguments(input: string): string[] {
	if (input.includes("\0")) throw new Error("启动参数不能包含空字符。");
	const arguments_: string[] = [];
	let currentArgument = "";
	let hasStartedArgument = false;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < input.length; index++) {
		const character = input.charAt(index);
		if (character === "\\" && quote !== "'") {
			const nextCharacter = input[index + 1];
			if (nextCharacter === undefined) throw new Error("启动参数末尾的反斜杠缺少要转义的字符。");
			if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(nextCharacter)) {
				currentArgument += character;
			} else {
				index++;
				if (nextCharacter !== "\n") {
					currentArgument += nextCharacter;
					hasStartedArgument = true;
				}
			}
		} else if (quote !== null) {
			if (character === quote) quote = null;
			else currentArgument += character;
		} else if (character === "'" || character === '"') {
			quote = character;
			hasStartedArgument = true;
		} else if (/\s/u.test(character)) {
			if (hasStartedArgument) arguments_.push(currentArgument);
			currentArgument = "";
			hasStartedArgument = false;
		} else {
			currentArgument += character;
			hasStartedArgument = true;
		}
	}
	if (quote !== null) throw new Error(quote === "'" ? "启动参数中的单引号未闭合。" : "启动参数中的双引号未闭合。");
	if (hasStartedArgument) arguments_.push(currentArgument);
	return arguments_;
}
