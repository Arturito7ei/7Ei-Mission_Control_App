"""Pure, unit-testable helpers for the 7Ei Claude Code adapter (Epic CC).

No IO here — no subprocess, no network, no filesystem. Just argv construction,
`--output-format stream-json` parsing, result extraction, secret redaction, the
fail-closed permission-mode gate, and workdir/worktree planning. The daemon
(`cc_adapter.py`) does all the IO and imports these; the tests exercise them
directly (`test/test_cc_headless.py`).

The verified headless contract (claude 2.1.x):
    claude -p "<prompt>" --output-format stream-json --verbose
      [--permission-mode plan|acceptEdits|bypassPermissions|default|dontAsk|auto]
      [--model <alias|full>] [--resume <session-id>]
      [--allowedTools "<t> <t>"] [--disallowedTools "<t> <t>"]
      [--append-system-prompt "<text>"] [--add-dir <dir> ...]
stream-json emits one JSON object per line: a `system` init event, `assistant`
message events, and a final `result` event carrying `result`, `total_cost_usd`,
`session_id`, `is_error`, `num_turns`.
"""

import json

# ── Permission posture (the safety chokepoint) ───────────────────────────────
#
# CC1 ships PROPOSE-AND-APPROVE only: Claude runs in `plan` mode — it may read
# and analyze but must PRESENT a plan; it never edits files or runs commands on
# the host. Autonomous host execution (`bypassPermissions` / `acceptEdits`) is
# CC6 and is fail-closed behind TWO explicit operator guards. `resolve_permission_mode`
# is the single chokepoint the daemon routes through; without both guards true,
# any non-`plan` request collapses to `plan`. This is the adapter twin of the
# wallet-mainnet / machine_exec "off until the operator flips two guards" pattern.

VALID_MODES = ("acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
# Everything that is NOT a read-only propose posture. `default` is included:
# headless `-p` cannot answer an interactive permission prompt, so `default`
# would either hang or silently act — treat it as autonomous-requiring too.
AUTONOMOUS_MODES = ("acceptEdits", "auto", "bypassPermissions", "default", "dontAsk")


def resolve_permission_mode(requested, *, autonomous_enabled=False, autonomous_confirmed=False):
    """The permission mode the adapter will ACTUALLY pass to `claude`.

    Fail-closed: an unknown mode → `plan`; any autonomous mode → `plan` unless
    BOTH `autonomous_enabled` and `autonomous_confirmed` are true (CC6's two
    guards). The daemon can never reach an autonomous posture by accident.
    """
    req = str(requested or "plan").strip()
    if req not in VALID_MODES:
        return "plan"
    if req == "plan":
        return "plan"
    if autonomous_enabled and autonomous_confirmed:
        return req
    return "plan"


def is_autonomous_mode(mode):
    """True if `mode` lets Claude act on the host without a per-op human gate."""
    return str(mode or "").strip() in AUTONOMOUS_MODES


# ── argv construction ────────────────────────────────────────────────────────

def build_claude_argv(prompt, *, claude_bin="claude", permission_mode="plan",
                      output_format="stream-json", model=None, resume=None,
                      allowed_tools=None, disallowed_tools=None,
                      append_system_prompt=None, add_dirs=None, extra_args=None):
    """Build the argv for one headless `claude` run. `prompt` is passed via
    `-p <prompt>` (argv, never a shell string). Returns a list of strings."""
    if not str(prompt or "").strip():
        raise ValueError("prompt is required")
    argv = [str(claude_bin), "-p", str(prompt), "--output-format", str(output_format)]
    # stream-json in print mode requires --verbose.
    if output_format == "stream-json":
        argv.append("--verbose")
    mode = str(permission_mode or "plan").strip()
    if mode:
        argv += ["--permission-mode", mode]
    if model:
        argv += ["--model", str(model)]
    if resume:
        argv += ["--resume", str(resume)]
    if allowed_tools:
        argv += ["--allowedTools", " ".join(str(t) for t in allowed_tools)]
    if disallowed_tools:
        argv += ["--disallowedTools", " ".join(str(t) for t in disallowed_tools)]
    if append_system_prompt:
        argv += ["--append-system-prompt", str(append_system_prompt)]
    for d in (add_dirs or []):
        argv += ["--add-dir", str(d)]
    for a in (extra_args or []):
        argv.append(str(a))
    return argv


def build_task_prompt(task, agent=None):
    """Assemble the prompt handed to `claude` from a task row (+ optional agent
    identity). Pure string builder — the daemon fetches task/agent over HTTP."""
    title = str((task or {}).get("title") or "").strip()
    body = str((task or {}).get("input") or "").strip()
    ws = (task or {}).get("workspace") or {}
    lines = []
    if title:
        lines.append(f"# Task: {title}")
    if body:
        lines.append(body)
    if ws:
        loc = []
        if ws.get("repoUrl"):
            loc.append(f"repo {ws['repoUrl']}")
        if ws.get("branch"):
            loc.append(f"branch {ws['branch']}")
        if ws.get("baseBranch"):
            loc.append(f"(from {ws['baseBranch']})")
        if loc:
            lines.append("Workspace: " + " · ".join(loc))
    return "\n\n".join(lines) if lines else (title or "(no task input)")


# ── stream-json parsing ──────────────────────────────────────────────────────

def parse_stream_json_line(line):
    """Parse one line of `--output-format stream-json`. Returns a dict event or
    None (blank / non-JSON / non-object)."""
    s = str(line or "").strip()
    if not s:
        return None
    try:
        obj = json.loads(s)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def assistant_text(event):
    """Concatenate the text blocks of an `assistant` stream-json event."""
    if not isinstance(event, dict):
        return ""
    msg = event.get("message")
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
            parts.append(str(block["text"]))
    return "".join(parts)


def event_log_line(event):
    """A short human-readable log line for a stream-json event (for
    /runs/:id/log), or None if the event is not worth logging."""
    if not isinstance(event, dict):
        return None
    t = event.get("type")
    if t == "system":
        sid = str(event.get("session_id") or "")[:8]
        model = event.get("model") or ""
        return f"· session {sid} started ({model})".rstrip()
    if t == "assistant":
        txt = assistant_text(event).strip()
        return txt[:2000] if txt else None
    if t == "result":
        cost = event.get("total_cost_usd")
        turns = event.get("num_turns")
        err = " (error)" if event.get("is_error") else ""
        bits = []
        if turns is not None:
            bits.append(f"{turns} turn(s)")
        if cost is not None:
            bits.append(f"${cost}")
        return f"✓ result{err}" + (f" — {', '.join(bits)}" if bits else "")
    return None


def extract_result(events):
    """Reduce a list of parsed stream-json events to the final task result.

    Returns { output, status, costUsd, tokensUsed, sessionId, isError }.
    Prefers the `result` event; falls back to concatenated assistant text.
    `status` is 'failed' when the result event is an error, else 'done'.
    """
    result_ev = None
    assistant_parts = []
    session_id = None
    for ev in events or []:
        if not isinstance(ev, dict):
            continue
        if ev.get("session_id") and not session_id:
            session_id = ev.get("session_id")
        if ev.get("type") == "assistant":
            txt = assistant_text(ev)
            if txt:
                assistant_parts.append(txt)
        elif ev.get("type") == "result":
            result_ev = ev
    if result_ev is not None:
        output = result_ev.get("result")
        if not isinstance(output, str) or not output.strip():
            output = "\n".join(assistant_parts).strip() or "(no output)"
        usage = result_ev.get("usage") or {}
        tokens = None
        if isinstance(usage, dict):
            it = usage.get("input_tokens")
            ot = usage.get("output_tokens")
            if isinstance(it, (int, float)) or isinstance(ot, (int, float)):
                tokens = int(it or 0) + int(ot or 0)
        return {
            "output": output,
            "status": "failed" if result_ev.get("is_error") else "done",
            "costUsd": result_ev.get("total_cost_usd"),
            "tokensUsed": tokens,
            "sessionId": result_ev.get("session_id") or session_id,
            "isError": bool(result_ev.get("is_error")),
        }
    # No result event — the run died or produced only assistant text.
    joined = "\n".join(assistant_parts).strip()
    return {
        "output": joined or "(claude produced no result event)",
        "status": "done" if joined else "failed",
        "costUsd": None,
        "tokensUsed": None,
        "sessionId": session_id,
        "isError": not joined,
    }


# ── Secret redaction ─────────────────────────────────────────────────────────

def redact(text, secret_values):
    """Replace any secret value substring with '***' before logs leave the host.
    `secret_values` is an iterable of raw secret strings (from GET /secrets)."""
    s = str(text or "")
    for v in secret_values or []:
        v = str(v or "")
        if len(v) >= 6 and v in s:  # skip trivially short values → false positives
            s = s.replace(v, "***")
    return s


# ── Workdir / worktree planning ──────────────────────────────────────────────

# ── PreToolUse guard hook (CC2 propose-and-approve bridge) ───────────────────
#
# When the adapter runs `claude` in a posture where it could attempt commands,
# it installs `cc_guard.py` as a Claude Code PreToolUse hook. For every Bash
# tool call the guard turns the intended command into a `machine_exec` approval
# (verbatim argv → the office A2 gate) and, in propose-and-approve mode, DENIES
# the tool call so nothing runs on the host. These are the pure pieces the hook
# imports; cc_guard.py does the stdin/HTTP IO. CC5 adds the denylist and CC6 the
# (guarded, off-by-default) allow path — this hook is that shared chokepoint.

# Tools whose calls are host command execution → routed to the machine_exec gate.
EXEC_TOOL_NAMES = ("Bash", "BashOutput", "KillShell", "KillBash")


def parse_hook_input(raw):
    """Parse the JSON a Claude Code hook receives on stdin. Returns a dict (or {})."""
    try:
        obj = json.loads(str(raw or "").strip() or "{}")
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def hook_action_from_tool(tool_name, tool_input, cwd=None):
    """Map a Claude tool call to the structured `machine_exec` action the office
    approval card renders, or None for a non-command tool. The shell command is
    represented as argv `['sh', '-lc', <command>]` so the human sees exactly what
    would run (shell operators and all); the raw command + cwd ride along for the
    audit trail. `allowlisted=False` until CC5 computes it, so the card warns."""
    name = str(tool_name or "")
    if name not in EXEC_TOOL_NAMES:
        return None
    ti = tool_input if isinstance(tool_input, dict) else {}
    command = str(ti.get("command") or "").strip()
    if not command:
        return None
    return {
        "type": "machine_exec",
        "action": {
            "argv": ["sh", "-lc", command],
            "command": command,
            "cwd": str(cwd) if cwd else None,
            "allowlisted": False,
        },
    }


def propose_only_decision(reason):
    """The PreToolUse hook output that DENIES a tool call (nothing runs on the
    host) — the propose-and-approve posture. Serialize to stdout in cc_guard.py."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": str(reason),
        }
    }


def allow_decision(reason):
    """The PreToolUse hook output that ALLOWS a tool call. Only reachable in the
    CC6 autonomous posture, and only after the CC5 denylist has passed."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": str(reason),
        }
    }


def build_guard_settings(guard_path, *, python_bin="python3", matcher="Bash", timeout=30):
    """Build the `--settings` JSON that registers cc_guard.py as a PreToolUse
    hook for command tools. Pure — cc_adapter.py writes it to a temp file."""
    return {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": str(matcher),
                    "hooks": [
                        {"type": "command", "command": f"{python_bin} {guard_path}", "timeout": int(timeout)}
                    ],
                }
            ]
        }
    }


def resolve_workdir(task, base_workdir, *, manage_worktree=False):
    """Decide where the `claude` run executes.

    Returns { cwd, worktree, branch, gitPlan } where gitPlan is None or a list
    of argv-lists to materialise a `cc/<slug>` worktree (only when a workspace
    is attached AND manage_worktree is on). Pure — the daemon runs gitPlan.
    """
    base = str(base_workdir or ".").rstrip("/") or "."
    ws = (task or {}).get("workspace") or {}
    worktree = ws.get("worktree")
    branch = ws.get("branch")
    if manage_worktree and worktree and branch:
        base_branch = ws.get("baseBranch") or "main"
        # `git worktree add -B <branch> <path> <base>` is idempotent-ish: -B
        # resets the branch if it exists. The daemon tolerates "already exists".
        git_plan = [["git", "worktree", "add", "-B", str(branch), str(worktree), str(base_branch)]]
        return {"cwd": str(worktree), "worktree": str(worktree), "branch": str(branch), "gitPlan": git_plan}
    return {"cwd": base, "worktree": None, "branch": branch, "gitPlan": None}
