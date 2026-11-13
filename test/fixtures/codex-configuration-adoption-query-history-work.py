import hashlib
import json
import sqlite3
import sys


PROGRESS_HANDLER_INSTRUCTION_INTERVAL = 100
DIAGNOSTIC_BYTES_PER_TARGET = 4096
CURRENT_FIELD_VERSION = 2000
HISTORY_SCENARIOS = (
    "same_profile_old_versions_other_writers",
    "same_writer_old_versions_same_value",
    "same_current_value_version_other_writer_changes",
    "same_current_change_many_other_writer_targets",
)


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def create_fixture_database(request, scenario, history_count):
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    for statement in request["schemaStatements"]:
        connection.executescript(statement)
    session = request["session"]
    field_key = compact_json(["config.toml", "model"])
    field_value = {"value": "query-history-model"}
    value_digest = hashlib.sha256(compact_json(field_value).encode()).hexdigest()
    writer = {
        "binding": session,
        "codexConfigurationProfileId": session["profileId"],
        "consumedProfileFieldVersions": {field_key: 0},
        "localExceptionOverrides": {},
    }
    connection.execute(
        "INSERT INTO configuration_writers(record_id,payload_json) VALUES (?,?)",
        (session["writerId"], compact_json(writer)),
    )
    connection.execute(
        "INSERT INTO configuration_profile_current_fields VALUES (?,?,?,?)",
        (session["profileId"], field_key, CURRENT_FIELD_VERSION, value_digest),
    )
    has_approved_field_identity = any(
        column["name"] == "approved_profile_field_value_version_key"
        for column in connection.execute("PRAGMA table_info(configuration_propagation_targets)")
    )

    def insert_change(change_id, sequence, field_version):
        connection.execute(
            """INSERT INTO configuration_changes(
                change_id,insertion_sequence,source_identity,profile_id,field_key,
                accepted_field_version,requires_processing,payload_json,approval_status,
                required_profile_field_version,current_field_value_digest,
                requires_legacy_target_observation,search_text,is_accepted_field_origin
            ) VALUES (?,?,?,?,?,?,0,'{}','approved',?,?,0,'',1)""",
            (
                change_id, sequence, "query-history-source", session["profileId"],
                field_key, field_version, field_version, value_digest,
            ),
        )

    def insert_target(change_id, sequence, writer_id, field_version, startup_successor=False):
        target = {
            "writerId": writer_id,
            "workspaceId": session["workspaceId"],
            "conversationSessionId": session["conversationSessionId"],
            "ownerReloadedAt": None if startup_successor else 1,
            "reason": "x" * DIAGNOSTIC_BYTES_PER_TARGET,
        }
        if startup_successor:
            target["appliedAtStartupByWriterId"] = session["writerId"]
        columns = "change_id,writer_id,insertion_sequence,status,payload_json,requires_legacy_observation"
        parameters = [change_id, writer_id, sequence, "applied", compact_json(target), 0]
        # 兼容修复前 schema，保证同一夹具能够直接运行原始 SQL 负对照。
        if has_approved_field_identity:
            columns += ",approved_profile_field_value_version_key"
            parameters.append(compact_json([session["profileId"], field_key, value_digest, field_version]))
        connection.execute(
            f"INSERT INTO configuration_propagation_targets({columns}) VALUES ({','.join('?' for _ in parameters)})",
            parameters,
        )
        connection.execute(
            "UPDATE configuration_changes SET propagation_target_total_count=propagation_target_total_count+1 WHERE change_id=?",
            (change_id,),
        )

    if scenario == "same_current_change_many_other_writer_targets":
        insert_change("shared-current-change", 1, CURRENT_FIELD_VERSION)
    for index in range(history_count):
        field_version = index + 1 if scenario in HISTORY_SCENARIOS[:2] else CURRENT_FIELD_VERSION
        change_id = "shared-current-change" if scenario == HISTORY_SCENARIOS[3] else f"history-change-{index}"
        if scenario != HISTORY_SCENARIOS[3]:
            insert_change(change_id, index + 1, field_version)
        writer_id = session["writerId"] if scenario == HISTORY_SCENARIOS[1] else f"other-writer-{index}"
        insert_target(change_id, index + 1, writer_id, field_version)
    if scenario in ("current_owner_reloaded", "current_startup_successor"):
        insert_change("current-positive-evidence", 1, CURRENT_FIELD_VERSION)
        startup_successor = scenario == "current_startup_successor"
        insert_target(
            "current-positive-evidence", 1,
            "predecessor-writer" if startup_successor else session["writerId"],
            CURRENT_FIELD_VERSION, startup_successor,
        )
    connection.commit()
    return connection


def measure_query(connection, query):
    progress_callbacks = 0

    def record_progress():
        nonlocal progress_callbacks
        progress_callbacks += 1
        return 0

    connection.set_progress_handler(record_progress, PROGRESS_HANDLER_INSTRUCTION_INTERVAL)
    try:
        rows = [dict(row) for row in connection.execute(query["sql"], query["parameters"]).fetchall()]
    finally:
        connection.set_progress_handler(None, 0)
    return {
        "virtualMachineInstructions": progress_callbacks * PROGRESS_HANDLER_INSTRUCTION_INTERVAL,
        "rows": rows,
    }


def expected_session_adoption_classification(query_kind, session, expected_status):
    if query_kind == "overview":
        return [{
            "profileId": session["profileId"], "total": 1,
            **{status: int(status == expected_status) for status in (
                "adopted", "local_selection", "saved", "pending", "conflict", "unverified"
            )},
        }]
    return [{
        "workspace_id": session["workspaceId"], "session_id": session["conversationSessionId"],
        "incarnation_id": session["runtimeSessionIncarnationId"], "writer_id": session["writerId"],
        "profile_id": session["profileId"], "adoption_status": expected_status,
    }]


def main():
    request = json.load(sys.stdin)
    report = {
        "sqliteVersion": sqlite3.sqlite_version,
        "progressHandlerInstructionInterval": PROGRESS_HANDLER_INSTRUCTION_INTERVAL,
        "diagnosticBytesPerTarget": DIAGNOSTIC_BYTES_PER_TARGET,
        "measurements": [], "comparisons": [], "failures": [],
    }
    for scenario in (*HISTORY_SCENARIOS, "current_owner_reloaded", "current_startup_successor"):
        negative_scenario = scenario in HISTORY_SCENARIOS
        scenario_measurements = {}
        for history_count in ((100, 1000) if negative_scenario else (0,)):
            connection = create_fixture_database(request, scenario, history_count)
            try:
                for query in request["queries"]:
                    measurement = {
                        "scenario": scenario, "historyCount": history_count, "queryKind": query["queryKind"],
                        **measure_query(connection, query),
                    }
                    report["measurements"].append(measurement)
                    scenario_measurements[(history_count, query["queryKind"])] = measurement
                    expected = expected_session_adoption_classification(
                        query["queryKind"], request["session"], "unverified" if negative_scenario else "adopted",
                    )
                    actual = [{key: row.get(key) for key in expected[0]} for row in measurement["rows"]]
                    if actual != expected or measurement["virtualMachineInstructions"] == 0:
                        report["failures"].append(f"{scenario}/{history_count} 分类错误或未执行：{measurement}")
            finally:
                connection.close()
        if negative_scenario:
            for query in request["queries"]:
                query_kind = query["queryKind"]
                small = scenario_measurements[(100, query_kind)]["virtualMachineInstructions"]
                large = scenario_measurements[(1000, query_kind)]["virtualMachineInstructions"]
                # 两个计量粒度的余量覆盖计数截断，预算不随墙钟或宿主负载浮动。
                maximum_large = small * 2 + PROGRESS_HANDLER_INSTRUCTION_INTERVAL * 2
                report["comparisons"].append({
                    "scenario": scenario, "queryKind": query_kind,
                    "smallHistoryInstructions": small, "largeHistoryInstructions": large,
                    "maximumLargeHistoryInstructions": maximum_large,
                })
                if large > maximum_large:
                    report["failures"].append(
                        f"{scenario}/{query_kind} 历史扩大十倍后扫描超预算：VM {small} → {large}，上限 {maximum_large}"
                    )
    print(compact_json(report))
    return int(bool(report["failures"]))


if __name__ == "__main__":
    sys.exit(main())
