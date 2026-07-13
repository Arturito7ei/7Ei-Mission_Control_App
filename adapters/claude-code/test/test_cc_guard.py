"""End-to-end tests for cc_guard.py (Epic CC / CC2 propose-and-approve hook).

Runs the guard as Claude Code would — piping a tool-call JSON on stdin — with no
MC_AGENT_TOKEN, so no approval is filed (offline) but the DECISION is exercised.

    python3 -m unittest discover -s adapters/claude-code/test
"""
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_GUARD = os.path.join(os.path.dirname(_HERE), "cc_guard.py")


def run_guard(payload, env_extra=None):
    env = {**os.environ}
    env.pop("MC_AGENT_TOKEN", None)  # offline: never file a real approval
    env.pop("CC_AUTONOMOUS", None)
    env.pop("CC_AUTONOMOUS_CONFIRM", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([sys.executable, _GUARD], input=json.dumps(payload),
                       capture_output=True, text=True, env=env, timeout=30)
    try:
        return json.loads(p.stdout.strip())
    except Exception:
        raise AssertionError(f"guard produced non-JSON stdout: {p.stdout!r} / stderr: {p.stderr!r}")


class GuardDecisions(unittest.TestCase):
    def test_bash_is_denied_and_proposed(self):
        d = run_guard({"tool_name": "Bash", "tool_input": {"command": "rm -rf /tmp/x"}, "cwd": "/repo"})
        out = d["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PreToolUse")
        self.assertEqual(out["permissionDecision"], "deny")           # nothing runs
        self.assertIn("machine_exec", out["permissionDecisionReason"])

    def test_non_command_tool_defers(self):
        d = run_guard({"tool_name": "Read", "tool_input": {"file_path": "/x"}})
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_empty_command_defers(self):
        d = run_guard({"tool_name": "Bash", "tool_input": {"command": ""}})
        self.assertEqual(d["hookSpecificOutput"]["permissionDecision"], "ask")


if __name__ == "__main__":
    unittest.main()
