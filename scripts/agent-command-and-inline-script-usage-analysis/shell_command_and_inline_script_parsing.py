"""复用首轮的静态 shell、内联脚本和 AST 分析；不求值或执行输入。"""
import ast
import hashlib
import json
from pathlib import Path
import re
import shlex


class UnresolvedShellExpansion(ValueError):
    pass


def tokenize_shell_with_source_spans(command):
    tokens = []
    cursor = 0
    contains_evaluated_expansion = False
    while cursor < len(command):
        if command[cursor] in ' \t\r':
            cursor += 1
            continue
        if command[cursor] == '#':
            following_newline = command.find('\n', cursor)
            cursor = len(command) if following_newline == -1 else following_newline
            continue
        start = cursor
        if command[cursor] in ';&|<>()\n':
            cursor += 1
            if command[start] in '<>' and cursor < len(command) and command[cursor] == '&':
                cursor += 1
            while cursor < len(command) and command[cursor] == command[start] and command[start] != '\n':
                cursor += 1
            tokens.append({'value': command[start:cursor], 'start': start, 'end': cursor, 'operator': True})
            continue
        quote = None
        contains_shell_expansion = False
        while cursor < len(command):
            character = command[cursor]
            if quote is None and character in ' \t\r;&|<>()\n':
                break
            if character == '\\' and quote != "'":
                cursor += 2
                continue
            if character in "'\"":
                if quote is None:
                    quote = character
                elif quote == character:
                    quote = None
            if quote != "'" and (character == '`' or command[cursor:cursor + 2] == '$('):
                contains_evaluated_expansion = True
            if quote != "'" and character in '$`':
                contains_shell_expansion = True
            cursor += 1
        if quote:
            raise ValueError('引号未闭合')
        raw_token = command[start:cursor].replace('\\\n', '')
        decoded = shlex.split(raw_token, comments=False)
        if not decoded:
            continue
        tokens.append({'value': decoded[0], 'start': start, 'end': cursor, 'operator': False,
                       'containsShellExpansion': contains_shell_expansion})
    return tokens, contains_evaluated_expansion


def identify_cli(command, working_directory):
    tokens, evaluated_expansion = tokenize_shell_with_source_spans(command)
    while tokens and (re.match(r'^\w+=', tokens[0]['value']) or tokens[0]['value'] in ['env', 'time', 'command']):
        tokens.pop(0)
    if not tokens:
        return None
    executable = Path(tokens[0]['value']).name
    prefix_token_count = None
    if executable in ['kanban', 'cline-kanban', '$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH', '${KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH}']:
        prefix_token_count = 1
    elif executable in ['node', 'nodejs'] and len(tokens) > 1:
        cli_path = tokens[1]['value']
        if Path(cli_path).name in ['kanban', 'cline-kanban'] or (Path(cli_path).name == 'cli.js' and 'playwright' not in cli_path and 'cline-kanban' in working_directory):
            prefix_token_count = 2
    elif executable == 'npx' and len(tokens) > 1 and tokens[1]['value'] in ['kanban', 'cline-kanban']:
        prefix_token_count = 2
    if prefix_token_count is None:
        return None
    arguments_with_shell_operators = tokens[prefix_token_count:]
    first_operator_index = next((index for index, token in enumerate(arguments_with_shell_operators) if token['operator']), len(arguments_with_shell_operators))
    argument_tokens = arguments_with_shell_operators[:first_operator_index]
    arguments = [token['value'] for token in argument_tokens]
    route = []
    for argument in arguments:
        if argument.startswith('-'):
            break
        route.append(argument)
        if len(route) == 4:
            break
    payload_characters = 0
    identity_characters = 0
    option_names = []
    for index, token in enumerate(argument_tokens):
        name = token['value']
        if not name.startswith('--'):
            continue
        option_names.append(name)
        if index + 1 >= len(argument_tokens):
            continue
        value_token = argument_tokens[index + 1]
        if name in ['--task-id', '--project-path']:
            identity_characters += value_token['end'] - token['start'] + 1
        if name in ['--goal', '--prompt', '--title', '--relation-assertion-rationale', '--message', '--reason']:
            payload_characters += len(value_token['value'])
    return {
        'route': ' '.join(route) or '[root]',
        'help': '--help' in arguments or '-h' in arguments,
        'single': not any(token['operator'] and (token['value'] not in ['<', '>', '>>', '>&', '<&', '\n'] or (token['value'] == '\n' and any(not later_token['operator'] for later_token in arguments_with_shell_operators[index + 1:]))) for index, token in enumerate(arguments_with_shell_operators)) and not evaluated_expansion,
        'hasShellOperators': first_operator_index != len(arguments_with_shell_operators),
        'hasEvaluatedExpansion': evaluated_expansion,
        'prefixCharacters': tokens[prefix_token_count - 1]['end'],
        'identityCharacters': identity_characters,
        'payloadCharacters': payload_characters,
        'optionNames': option_names,
    }


def classify_nonzero_output(record):
    if record['exitCode'] in [0, None]:
        return None
    output = record['output']
    objects = []
    for match in re.finditer(r'(?m)^\{', output):
        try:
            value, _ = json.JSONDecoder().raw_decode(output[match.start():])
            if isinstance(value, dict):
                objects.append(value)
        except (ValueError, RecursionError):
            pass
    if objects and objects[0].get('ok') is True:
        return 'CLI 已成功，后续 shell 失败'
    parser_errors = re.findall(r"^error: (unknown option '[^']+'|required option '[^']+' not specified|unknown command '[^']+')", output, re.M)
    if parser_errors:
        return parser_errors[-1]
    if objects and objects[0].get('ok') is False:
        message = str(objects[0].get('error') or objects[0].get('message') or '')
        if 'timeout' in message or 'fetch failed' in message:
            return '运行时连接或超时'
        if '缺少可核验' in message:
            return '身份门禁拒绝'
        return 'CLI 业务拒绝'
    if record['help'] and 'Usage: kanban' in output:
        return '帮助已成功，后续 shell 失败'
    return '重定向或来源未知，不能判定 CLI 失败'


def verify_parser():
    cases = [
        ("'/node path/node' '/cli path/kanban' task get --task-id 'abc'", True, 'task get'),
        ('kanban task rename-current-task --reason "正文 | ; > --help"', True, 'task rename-current-task'),
        ("kanban task create --prompt '$(false) `false`\n多行正文'", True, 'task create'),
        ('kanban task list | jq .', False, 'task list'),
        ('kanban task list\nkanban task list', False, 'task list'),
        ('kanban task list && false', False, 'task list'),
        ('kanban task list > output.json', True, 'task list'),
        ('kanban task list > output.json 2>&1', True, 'task list'),
        ('kanban task create --prompt "$(cat file)"', False, 'task create'),
        ('kanban task get \\\n --task-id abc', True, 'task get'),
    ]
    for command, single, route in cases:
        result = identify_cli(command, '/projects/cline-kanban')
        assert result['single'] is single, (command, result)
        assert result['route'] == route, (command, result)
    assert identify_cli('node /node_modules/playwright/cli.js test', '/projects/cline-kanban') is None
    assert classify_nonzero_output({'exitCode': 1, 'output': '{"ok": true}\n', 'help': False}) == 'CLI 已成功，后续 shell 失败'
    assert classify_nonzero_output({'exitCode': 1, 'output': '', 'help': False}).startswith('重定向')


def recognize_inline_interpreter_input_mode(tokens):
    position = 0
    while position < len(tokens) and (re.match(r'^\w+=', tokens[position]['value']) or tokens[position]['value'] in ['env', 'time', 'command']):
        position += 1
    if position >= len(tokens):
        return None
    executable = Path(tokens[position]['value']).name
    language = 'Python' if re.fullmatch(r'python(?:3(?:\.\d+)?)?', executable) else 'JavaScript' if executable in ['node', 'nodejs'] else None
    if language is None:
        return None
    position += 1
    reads_stdin = False
    operand_options = {'-X', '-W'} if language == 'Python' else {'--import', '--loader', '--experimental-loader', '--require', '-r', '--input-type', '--conditions', '-C', '--env-file'}
    evaluation_options = {'-c'} if language == 'Python' else {'-e', '--eval'}
    while position < len(tokens):
        token = tokens[position]
        value = token['value']
        following = tokens[position + 1] if position + 1 < len(tokens) else None
        if token['operator'] and value in ['<', '>', '>>', '<&', '>&', '<<', '<<<']:
            position += 2
            continue
        if value.isdigit() and following and following['operator'] and following['value'] in ['<', '>', '>>', '<&', '>&'] and token['end'] == following['start']:
            position += 1
            continue
        if value == '-':
            reads_stdin = True
        elif reads_stdin:
            pass
        elif value == '--':
            if following and not following['operator'] and following['value'] != '-':
                return {'language': language, 'mode': 'script_file',
                        'hasEvaluationLikeArgument': any(token['value'] in ['-c', '-e', '--eval'] for token in tokens[position + 1:])}
            return {'language': language, 'mode': 'standard_input'}
        elif value in evaluation_options and following and not following['operator']:
            if following.get('containsShellExpansion'):
                raise UnresolvedShellExpansion('内联正文含未观测的shell展开')
            return {'language': language, 'mode': 'evaluation_argument', 'body': following['value']}
        elif language == 'JavaScript' and value.startswith('--eval='):
            if token.get('containsShellExpansion'):
                raise UnresolvedShellExpansion('内联正文含未观测的shell展开')
            return {'language': language, 'mode': 'evaluation_argument', 'body': value[len('--eval='):]}
        elif value in operand_options:
            position += 2
            continue
        elif value in ['--help', '-h', '--version', '-V', '-m'] or (language == 'JavaScript' and value in ['-v', '--test', '--run']):
            return None
        elif not token['operator'] and not value.startswith('-'):
            return {'language': language, 'mode': 'script_file',
                    'hasEvaluationLikeArgument': any(token['value'] in ['-c', '-e', '--eval'] for token in tokens[position + 1:])}
        position += 1
    return {'language': language, 'mode': 'standard_input'}


def extract_inline_scripts(command):
    # heredoc正文只按所属命令消费，文档和脚本文件的stdin不当作解释器代码。
    scripts = []
    lines = command.splitlines(keepends=True)
    index = 0
    while index < len(lines):
        header = lines[index]
        index += 1
        while True:
            try:
                tokens, evaluated_expansion = tokenize_shell_with_source_spans(header)
                break
            except ValueError:
                if index == len(lines):
                    raise
                header += lines[index]
                index += 1
        if evaluated_expansion:
            raise UnresolvedShellExpansion('命令替换中的执行内容未静态提取')
        segments = [[]]
        for token in tokens:
            if token['operator'] and token['value'] in [';', '&&', '||', '|', '&', '\n']:
                segments.append([])
            else:
                segments[-1].append(token)
        for segment in segments:
            mode = recognize_inline_interpreter_input_mode(segment)
            if mode and mode['mode'] == 'evaluation_argument':
                scripts.append({'language': mode['language'], 'body': mode['body']})
            heredocs = [position for position, token in enumerate(segment) if token['operator'] and token['value'] == '<<']
            if len(heredocs) > 1 and mode and mode['mode'] == 'standard_input':
                raise ValueError('同一解释器的多个heredoc归属待证')
            for position in heredocs:
                if position + 1 == len(segment):
                    raise ValueError('heredoc缺少分隔符')
                delimiter = segment[position + 1]['value']
                strip_leading_tabs = delimiter.startswith('-')
                if strip_leading_tabs:
                    delimiter = delimiter[1:]
                body_lines = []
                while index < len(lines) and (lines[index].lstrip('\t') if strip_leading_tabs else lines[index]).rstrip('\r\n') != delimiter:
                    body_lines.append(lines[index].lstrip('\t') if strip_leading_tabs else lines[index])
                    index += 1
                if index == len(lines):
                    raise ValueError('heredoc未闭合')
                index += 1
                if mode and mode['mode'] == 'standard_input':
                    body = ''.join(body_lines)
                    delimiter_token = segment[position + 1]
                    delimiter_source = header[delimiter_token['start']:delimiter_token['end']]
                    if not any(character in delimiter_source for character in "'\"\\") and re.search(r'(?<!\\)[$`]', body):
                        raise UnresolvedShellExpansion('未引用heredoc正文含shell展开')
                    scripts.append({'language': mode['language'], 'body': body})
    return scripts


def describe_inline_script_exclusion_reason(command):
    try:
        tokens, _ = tokenize_shell_with_source_spans(command.splitlines()[0])
        segments = [[]]
        for token in tokens:
            if token['operator'] and token['value'] in [';', '&&', '||', '|', '&']:
                segments.append([])
            else:
                segments[-1].append(token)
        for segment in segments:
            mode = recognize_inline_interpreter_input_mode(segment)
            if mode and mode['mode'] == 'script_file':
                if mode['hasEvaluationLikeArgument']:
                    return 'script_file_evaluation_arguments_unresolved'
                if any(token['operator'] and token['value'] == '<<' for token in segment):
                    return 'script_file_standard_input_unclassified'
                return 'script_file_or_delegated_arguments_unresolved'
    except (ValueError, IndexError):
        pass
    return 'unsupported_or_delegated_interpreter_position'


def contains_observable_kanban_cli_subprocess_call(body):
    try:
        syntax = ast.parse(body)
    except (SyntaxError, ValueError):
        return bool(re.search(r'(?:execFileSync|execFile|spawnSync|spawn)\([^;]{0,450}kanban', body))
    assignments = {}
    for node in ast.walk(syntax):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = node.value
    def string_literals(node, visited_names=None):
        visited_names = visited_names or set()
        if isinstance(node, ast.Name) and node.id in assignments and node.id not in visited_names:
            return string_literals(assignments[node.id], visited_names | {node.id})
        result = [node.value] if isinstance(node, ast.Constant) and isinstance(node.value, str) else []
        for child in ast.iter_child_nodes(node):
            result.extend(string_literals(child, visited_names))
        return result
    for node in ast.walk(syntax):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        if not isinstance(node.func, ast.Attribute) or node.func.attr not in ['run', 'check_output', 'check_call', 'Popen', 'call']:
            continue
        values = string_literals(node.args[0])
        if any(Path(value).name in ['kanban', 'cline-kanban'] or ('cline-kanban' in value and value.endswith('/cli.js')) for value in values):
            return True
    return False


def observable_kanban_cli_subprocess_routes(body, working_directory):
    try:
        syntax = ast.parse(body)
    except (SyntaxError, ValueError):
        return []
    assignments = {target.id: node.value for node in ast.walk(syntax) if isinstance(node, ast.Assign)
                   for target in node.targets if isinstance(target, ast.Name)}
    subprocess_names = {alias.asname or alias.name for node in ast.walk(syntax) if isinstance(node, ast.Import)
                        for alias in node.names if alias.name == 'subprocess'}

    def static_arguments(node, visited=frozenset()):
        if isinstance(node, ast.Name) and node.id in assignments and node.id not in visited:
            return static_arguments(assignments[node.id], visited | {node.id})
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, (ast.List, ast.Tuple)):
            return [value for element in node.elts for value in static_arguments(element, visited)]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return static_arguments(node.left, visited) + static_arguments(node.right, visited)
        return [None]

    routes = []
    for node in ast.walk(syntax):
        if not isinstance(node, ast.Call) or not node.args or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in ['run', 'check_output', 'check_call', 'Popen', 'call'] or not isinstance(node.func.value, ast.Name) or node.func.value.id not in subprocess_names:
            continue
        argument = node.args[0]
        if isinstance(argument, ast.Constant):
            if not isinstance(argument.value, str) or not any(keyword.arg == 'shell' and isinstance(keyword.value, ast.Constant) and keyword.value.value is True for keyword in node.keywords):
                continue
            command = argument.value
        else:
            values = static_arguments(argument)
            known_prefix = values[:values.index(None)] if None in values else values
            command = shlex.join(known_prefix)
        cli = identify_cli(command, working_directory)
        if cli:
            routes.append(cli['route'])
    return routes


def classify_script(body):
    kanban_related = bool(re.search(r'\.cline/kanban|KANBAN_|\bkanban\s|cline-kanban|/api/trpc|[\'\"/]board\.json|[\'\"/]sessions\.json', body))
    labels = []
    if contains_observable_kanban_cli_subprocess_call(body):
        labels.append('包装 Kanban CLI 调用')
    if re.search(r'urllib|requests\.|http\.client|fetch\(', body) and re.search(r'kanban|trpc|3484|KANBAN_', body):
        labels.append('直接调用看板 HTTP 或 tRPC')
    if re.search(r'json\.load|json\.loads|JSON\.parse|read_text|readFileSync|open\(', body):
        labels.append('读取与筛选文件或 JSON')
    if re.search(r'write_text|writeFileSync|json\.dump|\.write\(|[\'\"]w[\'\"]', body):
        labels.append('生成或改写文件')
    if re.search(r'rollout|diagnostic-event|CommandExecution|aggregated_output|psutil|subprocess.*[\'\"]ps', body):
        labels.append('日志或进程调查')
    if not labels:
        labels.append('其他计算或实验')
    try:
        syntax = ast.parse(body)
        for node in ast.walk(syntax):
            if isinstance(node, ast.Constant):
                node.value = '<literal>'
        structure_digest = hashlib.sha256(ast.dump(syntax).encode()).hexdigest()
    except (SyntaxError, ValueError, TypeError):
        structure_digest = None
    return kanban_related, labels, structure_digest


def verify_extraction():
    assert extract_inline_scripts("python3 - <<'PY'\nprint(1)\nPY")[0]['body'] == 'print(1)\n'
    assert extract_inline_scripts('python3 existing-script.py') == []
    assert extract_inline_scripts("printf node -e 'not executed'") == []
    assert extract_inline_scripts("rg -e 'example' node") == []
    assert extract_inline_scripts("cat > note.md <<'DOC'\npython3 <<'PY'\nprint(1)\nPY\nDOC") == []
    assert len(extract_inline_scripts("node <<'JS'\nconsole.log(1)\nJS\npython3 <<'PY'\nprint(2)\nPY")) == 2
    assert classify_script("import json\njson.load(open('/home/.cline/kanban/board.json'))")[0]
    assert not classify_script("print(2)")[0]
    assert not contains_observable_kanban_cli_subprocess_call("import subprocess\nsubprocess.run(['git', 'status'])\nprint('cline-kanban')")
    assert contains_observable_kanban_cli_subprocess_call("import subprocess\ncli=['node','/bin/kanban']\nsubprocess.run(cli+['task','get'])")
