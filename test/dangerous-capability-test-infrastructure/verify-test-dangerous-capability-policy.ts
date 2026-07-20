import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type DangerousTestCapabilityPolicyViolationCode =
	| "direct-git-binary-execution"
	| "raw-parent-environment-spread"
	| "production-git-environment-used-by-test"
	| "child-process-used-outside-process-capability-lane";

export interface DangerousTestCapabilityPolicyViolation {
	code: DangerousTestCapabilityPolicyViolationCode;
	filePath: string;
	line: number;
	column: number;
	message: string;
}

const CHILD_PROCESS_MODULE_NAMES = new Set(["node:child_process", "child_process"]);
const CHILD_PROCESS_FUNCTION_NAMES = new Set(["exec", "execFile", "execFileSync", "fork", "spawn", "spawnSync"]);
const PROCESS_CAPABILITY_FILE_SUFFIXES = [".isolated-process-lifecycle.test.ts", ".integration.test.ts"];
const GIT_FIXTURE_PATH_SUFFIX = "test/dangerous-capability-test-infrastructure/isolated-git-test-workspace-fixture.ts";
const PROCESS_FIXTURE_PATH_SUFFIX =
	"test/dangerous-capability-test-infrastructure/owned-process-lifecycle-test-fixture.ts";
const REPOSITORY_CANARY_PATH_SUFFIX =
	"test/dangerous-capability-test-infrastructure/run-test-projects-with-invoking-repository-mutation-canary.ts";
const TRUSTED_CHILD_PROCESS_IMPLEMENTATION_PATH_SUFFIXES = [
	GIT_FIXTURE_PATH_SUFFIX,
	PROCESS_FIXTURE_PATH_SUFFIX,
	REPOSITORY_CANARY_PATH_SUFFIX,
];

function normalizePolicyPath(path: string): string {
	return path.split(sep).join("/");
}

function isRequireOfChildProcess(node: ts.Node | undefined): node is ts.CallExpression {
	return Boolean(
		node &&
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "require" &&
			node.arguments.length === 1 &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			CHILD_PROCESS_MODULE_NAMES.has(node.arguments[0].text),
	);
}

function collectChildProcessBindings(sourceFile: ts.SourceFile): {
	directFunctionNames: Set<string>;
	namespaceNames: Set<string>;
} {
	const directFunctionNames = new Set<string>();
	const namespaceNames = new Set<string>();
	const declarations: ts.VariableDeclaration[] = [];

	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteralLike(statement.moduleSpecifier) &&
			CHILD_PROCESS_MODULE_NAMES.has(statement.moduleSpecifier.text)
		) {
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) namespaceNames.add(bindings.name.text);
			if (bindings && ts.isNamedImports(bindings)) {
				for (const specifier of bindings.elements) {
					if (CHILD_PROCESS_FUNCTION_NAMES.has(specifier.propertyName?.text ?? specifier.name.text)) {
						directFunctionNames.add(specifier.name.text);
					}
				}
			}
		}
	}

	function collectDeclarations(node: ts.Node): void {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		ts.forEachChild(node, collectDeclarations);
	}
	collectDeclarations(sourceFile);

	let foundBinding = true;
	while (foundBinding) {
		foundBinding = false;
		for (const declaration of declarations) {
			const initializer = declaration.initializer;
			if (!initializer) continue;
			if (isRequireOfChildProcess(initializer)) {
				if (ts.isIdentifier(declaration.name) && !namespaceNames.has(declaration.name.text)) {
					namespaceNames.add(declaration.name.text);
					foundBinding = true;
				}
				if (ts.isObjectBindingPattern(declaration.name)) {
					for (const element of declaration.name.elements) {
						if (!ts.isIdentifier(element.name)) continue;
						const exportedName =
							element.propertyName &&
							(ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
								? element.propertyName.text
								: element.name.text;
						if (CHILD_PROCESS_FUNCTION_NAMES.has(exportedName) && !directFunctionNames.has(element.name.text)) {
							directFunctionNames.add(element.name.text);
							foundBinding = true;
						}
					}
				}
			}
			if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(initializer)) continue;
			if (directFunctionNames.has(initializer.text) && !directFunctionNames.has(declaration.name.text)) {
				directFunctionNames.add(declaration.name.text);
				foundBinding = true;
			}
			if (namespaceNames.has(initializer.text) && !namespaceNames.has(declaration.name.text)) {
				namespaceNames.add(declaration.name.text);
				foundBinding = true;
			}
		}
	}
	return { directFunctionNames, namespaceNames };
}

function isChildProcessCall(
	node: ts.CallExpression,
	bindings: ReturnType<typeof collectChildProcessBindings>,
): boolean {
	if (ts.isIdentifier(node.expression)) return bindings.directFunctionNames.has(node.expression.text);
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		bindings.namespaceNames.has(node.expression.expression.text) &&
		CHILD_PROCESS_FUNCTION_NAMES.has(node.expression.name.text)
	);
}

function collectStaticStringBindings(sourceFile: ts.SourceFile): Map<string, string> {
	const bindings = new Map<string, string>();
	function visit(node: ts.Node): void {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isStringLiteralLike(node.initializer)
		) {
			bindings.set(node.name.text, node.initializer.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return bindings;
}

function readStaticString(node: ts.Node | undefined, bindings: ReadonlyMap<string, string>): string | undefined {
	if (!node || !ts.isExpression(node)) return undefined;
	if (ts.isStringLiteralLike(node)) return node.text;
	return ts.isIdentifier(node) ? bindings.get(node.text) : undefined;
}

function isWholeProcessEnvironment(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process" &&
		node.name.text === "env"
	);
}

function containsWholeProcessEnvironment(node: ts.Node, aliases: ReadonlySet<string>): boolean {
	if (isWholeProcessEnvironment(node)) return true;
	if (ts.isIdentifier(node) && aliases.has(node.text)) return true;
	if (
		(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
		isWholeProcessEnvironment(node.expression)
	) {
		return false;
	}
	let found = false;
	ts.forEachChild(node, (child) => {
		if (!found && containsWholeProcessEnvironment(child, aliases)) found = true;
	});
	return found;
}

function collectWholeProcessEnvironmentAliases(sourceFile: ts.SourceFile): Set<string> {
	const declarations: ts.VariableDeclaration[] = [];
	function collect(node: ts.Node): void {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		ts.forEachChild(node, collect);
	}
	collect(sourceFile);
	const aliases = new Set<string>();
	let foundAlias = true;
	while (foundAlias) {
		foundAlias = false;
		for (const declaration of declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.initializer &&
				!aliases.has(declaration.name.text) &&
				containsWholeProcessEnvironment(declaration.initializer, aliases)
			) {
				aliases.add(declaration.name.text);
				foundAlias = true;
			}
		}
	}
	return aliases;
}

function createViolation(
	sourceFile: ts.SourceFile,
	filePath: string,
	node: ts.Node,
	code: DangerousTestCapabilityPolicyViolationCode,
	message: string,
): DangerousTestCapabilityPolicyViolation {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { code, filePath, line: position.line + 1, column: position.character + 1, message };
}

export function analyzeTestSourceDangerousCapabilityPolicy(options: {
	filePath: string;
	sourceText: string;
}): DangerousTestCapabilityPolicyViolation[] {
	const normalizedFilePath = normalizePolicyPath(options.filePath);
	const sourceFile = ts.createSourceFile(
		options.filePath,
		options.sourceText,
		ts.ScriptTarget.Latest,
		true,
		options.filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const childProcessBindings = collectChildProcessBindings(sourceFile);
	const staticStringBindings = collectStaticStringBindings(sourceFile);
	const processEnvironmentAliases = collectWholeProcessEnvironmentAliases(sourceFile);
	const trustedImplementation = TRUSTED_CHILD_PROCESS_IMPLEMENTATION_PATH_SUFFIXES.some((suffix) =>
		normalizedFilePath.endsWith(suffix),
	);
	const childProcessAllowed =
		trustedImplementation || PROCESS_CAPABILITY_FILE_SUFFIXES.some((suffix) => normalizedFilePath.endsWith(suffix));
	const violations: DangerousTestCapabilityPolicyViolation[] = [];
	const recordedRawEnvironmentNodeStarts = new Set<number>();

	function recordRawEnvironment(node: ts.Node): void {
		const start = node.getStart(sourceFile);
		if (recordedRawEnvironmentNodeStarts.has(start)) return;
		recordedRawEnvironmentNodeStarts.add(start);
		violations.push(
			createViolation(
				sourceFile,
				options.filePath,
				node,
				"raw-parent-environment-spread",
				"测试不得把完整 process.env 交给子进程；请使用危险能力 fixture 的清洗环境。",
			),
		);
	}

	function visit(node: ts.Node): void {
		if (!trustedImplementation && ts.isPropertyAssignment(node)) {
			const propertyName = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : "";
			if (propertyName === "env" && containsWholeProcessEnvironment(node.initializer, processEnvironmentAliases)) {
				recordRawEnvironment(node);
			}
		}
		if (
			!trustedImplementation &&
			ts.isSpreadAssignment(node) &&
			containsWholeProcessEnvironment(node.expression, processEnvironmentAliases)
		) {
			recordRawEnvironment(node);
		}
		if (
			!trustedImplementation &&
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "Object" &&
			(node.expression.name.text === "entries" || node.expression.name.text === "assign") &&
			node.arguments.some((argument) => containsWholeProcessEnvironment(argument, processEnvironmentAliases))
		) {
			recordRawEnvironment(node);
		}

		if (ts.isCallExpression(node) && isChildProcessCall(node, childProcessBindings)) {
			if (!childProcessAllowed) {
				violations.push(
					createViolation(
						sourceFile,
						options.filePath,
						node,
						"child-process-used-outside-process-capability-lane",
						"直接 child_process 调用只能位于 process/integration lane 或危险能力基础设施。",
					),
				);
			}
			if (readStaticString(node.arguments[0], staticStringBindings) === "git") {
				if (
					!normalizedFilePath.endsWith(GIT_FIXTURE_PATH_SUFFIX) &&
					!normalizedFilePath.endsWith(REPOSITORY_CANARY_PATH_SUFFIX)
				) {
					violations.push(
						createViolation(
							sourceFile,
							options.filePath,
							node,
							"direct-git-binary-execution",
							"测试不得直接执行 Git binary；请使用 isolated Git fixture。",
						),
					);
				}
				if (options.sourceText.includes("createGitProcessEnv")) {
					violations.push(
						createViolation(
							sourceFile,
							options.filePath,
							node,
							"production-git-environment-used-by-test",
							"真实测试 Git 命令不得使用 production createGitProcessEnv。",
						),
					);
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return violations;
}

function collectTypeScriptFiles(directoryPath: string): string[] {
	return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directoryPath, entry.name);
		return entry.isDirectory()
			? collectTypeScriptFiles(path)
			: entry.isFile() && /\.tsx?$/u.test(entry.name)
				? [path]
				: [];
	});
}

export function analyzeRepositoryTestDangerousCapabilityPolicy(
	repositoryRootDirectoryPath: string,
): DangerousTestCapabilityPolicyViolation[] {
	const repositoryRoot = resolve(repositoryRootDirectoryPath);
	return collectTypeScriptFiles(resolve(repositoryRoot, "test")).flatMap((filePath) =>
		analyzeTestSourceDangerousCapabilityPolicy({
			filePath: normalizePolicyPath(relative(repositoryRoot, filePath)),
			sourceText: readFileSync(filePath, "utf8"),
		}),
	);
}

function runPolicyCommand(): void {
	const violations = analyzeRepositoryTestDangerousCapabilityPolicy(process.cwd());
	if (violations.length === 0) {
		process.stdout.write("危险测试能力策略检查通过。\n");
		return;
	}
	for (const violation of violations) {
		process.stderr.write(
			`${violation.filePath}:${violation.line}:${violation.column} [${violation.code}] ${violation.message}\n`,
		);
	}
	process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runPolicyCommand();
