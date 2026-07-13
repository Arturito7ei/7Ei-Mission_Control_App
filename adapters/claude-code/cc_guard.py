#!/usr/bin/env python3
"""
7Ei Mission Control — Claude Code PreToolUse guard hook (Epic CC, CC2 + CC5/CC6).

Claude Code invokes this before a tool call, passing the call as JSON on stdin.
For a command tool (Bash) the guard:

  1. turns the intended command into a `machine_exec` approval (verbatim argv)
     and files it to the office A2 gate via POST /api/agent/approvals; then
  2. in PROPOSE-AND-APPROVE mode (the default, CC2) DENIES the tool call, so the
     command NEVER runs on the host — the office approves the exact argv instead.

Autonomous execution (CC6) is fail-closed OFF: only when BOTH operator guards
are set (CC_AUTONOMOUS=1 + CC_AUTONOMOUS_CONFIRM=1) does the guard consult the
CC5 command denylist — a denylisted command is still DENIED; only a non-denylisted
command is ALLOWED to run. Without both guards, every command is proposed + denied.

Stdlib only. Installed via `--settings` (see cc_headless.build_guard_settings).

  MC_BASE_URL / MC_AGENT_TOKEN   file the machine_exec approval
  CC_AUTONOMOUS / CC_AUTONOMOUS_CONFIRM   CC6 guards (BOTH required; default OFF)
"""
import json, os, sys, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cc_headless as cc

try:
    import cc_denylist  # CC5 — optional at CC2 time; guard is fail-closed without it
except Exception:  # pragma: no cover - exercised once CC5 lands
    cc_denylist = None

BASE = os.environ.get("MC_BASE_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.environ.get("MC_AGENT_TOKEN", "")
AUTONOMOUS = os.environ.get("CC_AUTONOMOUS", "") in ("1", "true", "yes")
AUTONOMOUS_CONFIRM = os.environ.get("CC_AUTONOMOUS_CONFIRM", "") in ("1", "true", "yes")


def file_approval(action):
    """Best-effort: file the machine_exec approval with the office. Never raises."""
    if not TOKEN:
        return
    try:
        req = urllib.request.Request(
            BASE + "/api/agent/approvals",
            data=json.dumps({"type": "machine_exec", "action": action["action"]}).encode(),
            method="POST")
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass


def emit(decision):
    sys.stdout.write(json.dumps(decision))
    sys.stdout.flush()


def main():
    payload = cc.parse_hook_input(sys.stdin.read())
    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    cwd = payload.get("cwd")

    action = cc.hook_action_from_tool(tool_name, tool_input, cwd)
    if action is None:
        # Not a command tool → the guard has no opinion; let normal permissions apply.
        emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask",
                                     "permissionDecisionReason": "non-command tool — deferring to Claude Code permissions"}})
        return

    command = action["action"].get("command", "")

    # Autonomous posture (CC6) — both guards + the CC5 denylist must pass.
    if AUTONOMOUS and AUTONOMOUS_CONFIRM and cc_denylist is not None:
        verdict = cc_denylist.evaluate_command(command)
        if verdict.get("decision") == "deny":
            file_approval(action)  # record the refusal intent for the audit trail
            emit(cc.propose_only_decision(
                f"Refused by the 7Ei command denylist: {verdict.get('reason','denylisted')}. Not executed."))
            return
        if verdict.get("decision") == "allow":
            emit(cc.allow_decision(f"Allowed by policy (autonomous): {verdict.get('reason','allowlisted')}."))
            return
        # 'gate' → fall through to propose-and-approve below.

    # Propose-and-approve (default): file the verbatim argv + DENY (nothing runs).
    file_approval(action)
    emit(cc.propose_only_decision(
        "Proposed to the 7Ei office as a machine_exec approval (verbatim argv). "
        "This command was NOT executed; a human must approve it with a fresh session."))


if __name__ == "__main__":
    main()
