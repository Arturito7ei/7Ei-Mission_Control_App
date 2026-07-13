"""Unit tests for cc_headless.py (Epic CC — Claude Code adapter pure helpers).

    python3 -m unittest discover -s adapters/claude-code/test
Stdlib only. No network, no subprocess, no `claude` binary needed.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cc_headless as cc  # noqa: E402


class PermissionModeGate(unittest.TestCase):
    def test_default_is_plan(self):
        self.assertEqual(cc.resolve_permission_mode(None), "plan")
        self.assertEqual(cc.resolve_permission_mode("plan"), "plan")

    def test_unknown_collapses_to_plan(self):
        self.assertEqual(cc.resolve_permission_mode("yolo"), "plan")

    def test_autonomous_refused_without_both_guards(self):
        for mode in ("bypassPermissions", "acceptEdits", "default", "auto", "dontAsk"):
            self.assertEqual(cc.resolve_permission_mode(mode), "plan")
            self.assertEqual(cc.resolve_permission_mode(mode, autonomous_enabled=True), "plan")
            self.assertEqual(cc.resolve_permission_mode(mode, autonomous_confirmed=True), "plan")

    def test_autonomous_allowed_only_with_both_guards(self):
        self.assertEqual(
            cc.resolve_permission_mode("bypassPermissions", autonomous_enabled=True, autonomous_confirmed=True),
            "bypassPermissions",
        )
        # plan is never "upgraded" by the guards
        self.assertEqual(
            cc.resolve_permission_mode("plan", autonomous_enabled=True, autonomous_confirmed=True),
            "plan",
        )

    def test_is_autonomous_mode(self):
        self.assertTrue(cc.is_autonomous_mode("bypassPermissions"))
        self.assertFalse(cc.is_autonomous_mode("plan"))


class BuildArgv(unittest.TestCase):
    def test_minimal(self):
        argv = cc.build_claude_argv("do the thing")
        self.assertEqual(argv[:3], ["claude", "-p", "do the thing"])
        self.assertIn("--output-format", argv)
        self.assertIn("stream-json", argv)
        self.assertIn("--verbose", argv)  # required with stream-json in -p
        self.assertIn("--permission-mode", argv)
        self.assertIn("plan", argv)

    def test_prompt_is_argv_not_shell(self):
        # An injection-y prompt stays a single argv element (never a shell string).
        nasty = "fix bug; rm -rf / #"
        argv = cc.build_claude_argv(nasty)
        self.assertEqual(argv[2], nasty)

    def test_empty_prompt_raises(self):
        with self.assertRaises(ValueError):
            cc.build_claude_argv("   ")

    def test_all_options(self):
        argv = cc.build_claude_argv(
            "go", claude_bin="/opt/claude", model="opus", resume="sess-1",
            allowed_tools=["Read", "Grep"], disallowed_tools=["Bash", "Edit"],
            append_system_prompt="You are contained.", add_dirs=["/a", "/b"],
            extra_args=["--betas", "x"],
        )
        self.assertEqual(argv[0], "/opt/claude")
        self.assertIn("--model", argv); self.assertIn("opus", argv)
        self.assertIn("--resume", argv); self.assertIn("sess-1", argv)
        self.assertIn("--allowedTools", argv); self.assertIn("Read Grep", argv)
        self.assertIn("--disallowedTools", argv); self.assertIn("Bash Edit", argv)
        self.assertIn("--append-system-prompt", argv)
        self.assertEqual(argv.count("--add-dir"), 2)
        self.assertIn("--betas", argv)


class BuildPrompt(unittest.TestCase):
    def test_title_and_body(self):
        p = cc.build_task_prompt({"title": "Add helper", "input": "Add formatDate()."})
        self.assertIn("Add helper", p)
        self.assertIn("formatDate", p)

    def test_workspace_context(self):
        p = cc.build_task_prompt({"title": "x", "workspace": {"repoUrl": "git@h:r.git", "branch": "cc/x-1", "baseBranch": "main"}})
        self.assertIn("cc/x-1", p)
        self.assertIn("git@h:r.git", p)

    def test_empty(self):
        self.assertEqual(cc.build_task_prompt({}), "(no task input)")


class StreamJson(unittest.TestCase):
    def test_parse_line(self):
        self.assertIsNone(cc.parse_stream_json_line(""))
        self.assertIsNone(cc.parse_stream_json_line("not json"))
        self.assertIsNone(cc.parse_stream_json_line("[1,2]"))  # not an object
        self.assertEqual(cc.parse_stream_json_line('{"type":"x"}'), {"type": "x"})

    def test_assistant_text(self):
        ev = {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Hello "}, {"type": "tool_use", "name": "Read"}, {"type": "text", "text": "world"}]}}
        self.assertEqual(cc.assistant_text(ev), "Hello world")

    def test_event_log_line(self):
        self.assertIn("session", cc.event_log_line({"type": "system", "session_id": "abcdef123", "model": "sonnet"}))
        self.assertEqual(cc.event_log_line({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}), "hi")
        self.assertIsNone(cc.event_log_line({"type": "assistant", "message": {"content": []}}))
        self.assertIn("result", cc.event_log_line({"type": "result", "num_turns": 3, "total_cost_usd": 0.01}))

    def test_extract_result_success(self):
        events = [
            {"type": "system", "session_id": "s1", "model": "sonnet"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}},
            {"type": "result", "subtype": "success", "result": "Done: added helper.",
             "total_cost_usd": 0.042, "session_id": "s1", "is_error": False, "num_turns": 2,
             "usage": {"input_tokens": 100, "output_tokens": 50}},
        ]
        r = cc.extract_result(events)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["output"], "Done: added helper.")
        self.assertEqual(r["costUsd"], 0.042)
        self.assertEqual(r["tokensUsed"], 150)
        self.assertEqual(r["sessionId"], "s1")
        self.assertFalse(r["isError"])

    def test_extract_result_error(self):
        events = [{"type": "result", "subtype": "error", "result": "boom", "is_error": True, "session_id": "s2"}]
        r = cc.extract_result(events)
        self.assertEqual(r["status"], "failed")
        self.assertTrue(r["isError"])

    def test_extract_result_no_result_event(self):
        events = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "partial answer"}]}, "session_id": "s3"}]
        r = cc.extract_result(events)
        self.assertEqual(r["output"], "partial answer")
        self.assertEqual(r["sessionId"], "s3")

    def test_extract_result_empty(self):
        r = cc.extract_result([])
        self.assertEqual(r["status"], "failed")
        self.assertTrue(r["isError"])


class Redact(unittest.TestCase):
    def test_redacts_long_secrets(self):
        self.assertEqual(cc.redact("token is sk-abcdef123456", ["sk-abcdef123456"]), "token is ***")

    def test_skips_short_values(self):
        # short values would cause false positives → left alone
        self.assertEqual(cc.redact("a cat sat", ["cat"]), "a cat sat")

    def test_handles_empty(self):
        self.assertEqual(cc.redact("hi", []), "hi")
        self.assertEqual(cc.redact(None, ["secretvalue"]), "")


class ResolveWorkdir(unittest.TestCase):
    def test_no_workspace_uses_base(self):
        r = cc.resolve_workdir({"title": "x"}, "/work")
        self.assertEqual(r["cwd"], "/work")
        self.assertIsNone(r["gitPlan"])

    def test_workspace_but_manage_off(self):
        task = {"workspace": {"worktree": "/w/.worktrees/task-1", "branch": "cc/x-1", "baseBranch": "main"}}
        r = cc.resolve_workdir(task, "/work", manage_worktree=False)
        self.assertEqual(r["cwd"], "/work")
        self.assertIsNone(r["gitPlan"])

    def test_workspace_manage_on_plans_worktree(self):
        task = {"workspace": {"worktree": "/w/.worktrees/task-1", "branch": "cc/x-1", "baseBranch": "main"}}
        r = cc.resolve_workdir(task, "/work", manage_worktree=True)
        self.assertEqual(r["cwd"], "/w/.worktrees/task-1")
        self.assertEqual(r["gitPlan"][0][:4], ["git", "worktree", "add", "-B"])
        self.assertIn("cc/x-1", r["gitPlan"][0])


class GuardHook(unittest.TestCase):
    def test_parse_hook_input(self):
        self.assertEqual(cc.parse_hook_input('{"tool_name":"Bash"}'), {"tool_name": "Bash"})
        self.assertEqual(cc.parse_hook_input(""), {})
        self.assertEqual(cc.parse_hook_input("not json"), {})
        self.assertEqual(cc.parse_hook_input("[1]"), {})

    def test_hook_action_from_bash(self):
        a = cc.hook_action_from_tool("Bash", {"command": "npm test && rm -rf build"}, cwd="/repo")
        self.assertEqual(a["type"], "machine_exec")
        # command represented verbatim after `sh -lc` so the human sees exactly what runs
        self.assertEqual(a["action"]["argv"], ["sh", "-lc", "npm test && rm -rf build"])
        self.assertEqual(a["action"]["command"], "npm test && rm -rf build")
        self.assertEqual(a["action"]["cwd"], "/repo")
        self.assertFalse(a["action"]["allowlisted"])

    def test_hook_action_non_command_tool_is_none(self):
        self.assertIsNone(cc.hook_action_from_tool("Read", {"file_path": "/x"}))
        self.assertIsNone(cc.hook_action_from_tool("Edit", {"file_path": "/x"}))

    def test_hook_action_empty_command_is_none(self):
        self.assertIsNone(cc.hook_action_from_tool("Bash", {"command": "  "}))
        self.assertIsNone(cc.hook_action_from_tool("Bash", {}))

    def test_propose_only_decision_denies(self):
        d = cc.propose_only_decision("proposed")
        self.assertEqual(d["hookSpecificOutput"]["hookEventName"], "PreToolUse")
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_allow_decision(self):
        self.assertEqual(cc.allow_decision("ok")["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_build_guard_settings(self):
        s = cc.build_guard_settings("/x/cc_guard.py")
        hooks = s["hooks"]["PreToolUse"]
        self.assertEqual(hooks[0]["matcher"], "Bash")
        self.assertIn("cc_guard.py", hooks[0]["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main()
