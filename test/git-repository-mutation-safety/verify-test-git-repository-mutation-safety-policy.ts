import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type TestGitRepositoryMutationSafetyPolicyViolationCode =
	| "direct-git-binary-execution"
	| "raw-parent-environment-spread"
	| "production-git-environment-used-by-test";

export interface TestGitRepositoryMutationSafetyPolicyViolation {
	code: TestGitRepositoryMutationSafetyPolicyViolationCode;
	filePath: string;
	line: number;
	column: number;
	message: string;
}

const CHILD_PROCESS_MODULE_NAMES = new Set(["node:child_process", "child_process"]);
const CHILD_PROCESS_FUNCTION_NAMES = new Set(["exec", "execFile", "execFileSync", "fork", "spawn", "spawnSync"]);
const PRODUCTION_GIT_PROCESS_ENVIRONMENT_MODULE_SUFFIX = "/src/core/git-process-env";
const GIT_FIXTURE_PATH_SUFFIX = "test/git-repository-mutation-safety/isolated-git-test-workspace-fixture.ts";
const REPOSITORY_CANARY_PATH_SUFFIX =
	"test/git-repository-mutation-safety/run-test-projects-with-invoking-repository-mutation-canary.ts";

function normalizePolicyPath(path: string): string {
	return path.split(sep).join("/");
}

function collectImportedChildProcessBindings(sourceFile: ts.SourceFile): {
	directFunctionNames: ReadonlySet<string>;
	namespaceNames: ReadonlySet<string>;
	productionGitEnvironmentFactoryNames: ReadonlySet<string>;
} {
	const directFunctionNames = new Set<string>();
	const namespaceNames = new Set<string>();
	const productionGitEnvironmentFactoryNames = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
		const namedBindings = statement.importClause?.namedBindings;
		if (CHILD_PROCESS_MODULE_NAMES.has(statement.moduleSpecifier.text)) {
			if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaceNames.add(namedBindings.name.text);
		}
		if (
			namedBindings &&
			ts.isNamedImports(namedBindings) &&
			CHILD_PROCESS_MODULE_NAMES.has(statement.moduleSpecifier.text)
		) {
			for (const specifier of namedBindings.elements) {
				const importedName = specifier.propertyName?.text ?? specifier.name.text;
				if (CHILD_PROCESS_FUNCTION_NAMES.has(importedName)) directFunctionNames.add(specifier.name.text);
			}
		}
		if (
			namedBindings &&
			ts.isNamedImports(namedBindings) &&
			statement.moduleSpecifier.text.endsWith(PRODUCTION_GIT_PROCESS_ENVIRONMENT_MODULE_SUFFIX)
		) {
			for (const specifier of namedBindings.elements) {
				const importedName = specifier.propertyName?.text ?? specifier.name.text;
				if (importedName === "createGitProcessEnv") {
					productionGitEnvironmentFactoryNames.add(specifier.name.text);
				}
			}
		}
	}
	return { directFunctionNames, namespaceNames, productionGitEnvironmentFactoryNames };
}

function isImportedChildProcessCall(
	node: ts.CallExpression,
	bindings: ReturnType<typeof collectImportedChildProcessBindings>,
): boolean {
	if (ts.isIdentifier(node.expression)) return bindings.directFunctionNames.has(node.expression.text);
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		bindings.namespaceNames.has(node.expression.expression.text) &&
		CHILD_PROCESS_FUNCTION_NAMES.has(node.expression.name.text)
	);
}

function isWholeProcessEnvironment(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process" &&
		node.name.text === "env"
	);
}

function findChildProcessEnvironmentInitializer(node: ts.CallExpression): ts.Expression | null {
	const optionsObject = node.arguments.find(ts.isObjectLiteralExpression);
	if (!optionsObject) return null;
	const environmentProperty = optionsObject.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) &&
			(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
			property.name.text === "env",
	);
	return environmentProperty?.initializer ?? null;
}

function childProcessCallPassesWholeParentEnvironment(node: ts.CallExpression): boolean {
	const environmentInitializer = findChildProcessEnvironmentInitializer(node);
	if (!environmentInitializer) return false;
	if (isWholeProcessEnvironment(environmentInitializer)) return true;
	return (
		ts.isObjectLiteralExpression(environmentInitializer) &&
		environmentInitializer.properties.some(
			(property) => ts.isSpreadAssignment(property) && isWholeProcessEnvironment(property.expression),
		)
	);
}

function childProcessCallUsesProductionGitEnvironment(
	node: ts.CallExpression,
	productionGitEnvironmentFactoryNames: ReadonlySet<string>,
): boolean {
	const environmentInitializer = findChildProcessEnvironmentInitializer(node);
	return (
		environmentInitializer !== null &&
		ts.isCallExpression(environmentInitializer) &&
		ts.isIdentifier(environmentInitializer.expression) &&
		productionGitEnvironmentFactoryNames.has(environmentInitializer.expression.text)
	);
}

function createViolation(
	sourceFile: ts.SourceFile,
	filePath: string,
	node: ts.Node,
	code: TestGitRepositoryMutationSafetyPolicyViolationCode,
	message: string,
): TestGitRepositoryMutationSafetyPolicyViolation {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { code, filePath, line: position.line + 1, column: position.character + 1, message };
}

export function analyzeTestSourceGitRepositoryMutationSafetyPolicy(options: {
	filePath: string;
	sourceText: string;
}): TestGitRepositoryMutationSafetyPolicyViolation[] {
	const normalizedFilePath = normalizePolicyPath(options.filePath);
	const sourceFile = ts.createSourceFile(
		options.filePath,
		options.sourceText,
		ts.ScriptTarget.Latest,
		true,
		options.filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const childProcessBindings = collectImportedChildProcessBindings(sourceFile);
	const trustedGitImplementation =
		normalizedFilePath.endsWith(GIT_FIXTURE_PATH_SUFFIX) ||
		normalizedFilePath.endsWith(REPOSITORY_CANARY_PATH_SUFFIX);
	const violations: TestGitRepositoryMutationSafetyPolicyViolation[] = [];

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && isImportedChildProcessCall(node, childProcessBindings)) {
			if (!trustedGitImplementation && childProcessCallPassesWholeParentEnvironment(node)) {
				violations.push(
					createViolation(
						sourceFile,
						options.filePath,
						node,
						"raw-parent-environment-spread",
						"测试不得把完整 process.env 交给子进程；请显式构造已清除 GIT_* 的环境。",
					),
				);
			}
			if (
				!trustedGitImplementation &&
				ts.isStringLiteralLike(node.arguments[0]) &&
				node.arguments[0].text === "git"
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
				if (
					childProcessCallUsesProductionGitEnvironment(
						node,
						childProcessBindings.productionGitEnvironmentFactoryNames,
					)
				) {
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

export function analyzeRepositoryTestGitRepositoryMutationSafetyPolicy(
	repositoryRootDirectoryPath: string,
): TestGitRepositoryMutationSafetyPolicyViolation[] {
	const repositoryRoot = resolve(repositoryRootDirectoryPath);
	return collectTypeScriptFiles(resolve(repositoryRoot, "test")).flatMap((filePath) =>
		analyzeTestSourceGitRepositoryMutationSafetyPolicy({
			filePath: normalizePolicyPath(relative(repositoryRoot, filePath)),
			sourceText: readFileSync(filePath, "utf8"),
		}),
	);
}

function runPolicyCommand(): void {
	const violations = analyzeRepositoryTestGitRepositoryMutationSafetyPolicy(process.cwd());
	if (violations.length === 0) {
		process.stdout.write("Git 测试安全策略检查通过。\n");
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
