#!/usr/bin/env python3
"""
7Ei Mission Control — Claude Code runtime adapter (Epic CC, CC1).

A stdlib-only poll loop that turns Claude Code into a first-class Mission
Control fleet executor. It authenticates with an `mca_` agent token, claims
tasks the office assigned to this `runtime:'claude_code'` agent, runs a HEADLESS
`claude -p` in the target workspace / `cc/`-worktree, streams the run's
stream-json output to the task thread, and posts the result + heartbeats.

SAFETY — CC1 ships PROPOSE-AND-APPROVE only:
  * `claude` runs in `--permission-mode plan` by default: it reads, analyses,
    and PROPOSES a plan; it does NOT edit files or run commands on the host.
  * Autonomous host execution (`bypassPermissions`) is CC6 and is fail-closed
    behind TWO explicit operator guards (CC_AUTONOMOUS=1 + CC_AUTONOMOUS_CONFIRM=1).
    `cc_headless.resolve_permission_mode` is the single chokepoint — without both
    guards, any non-`plan` request collapses to `plan`.
  * This adapter never touches the live OpenClaw install; it is its own thing.

Stdlib only (urllib, json, subprocess, threading) — no pip install.

  MC_BASE_URL        app backend, e.g. https://7ei-backend.fly.dev
  MC_AGENT_TOKEN     mca_...  (external agent, runtime=claude_code; shown once at onboarding)
  MC_WORKDIR         working dir for runs (default: cwd)
  MC_POLL_SECONDS    loop interval (default: 20)
  CC_CLAUDE_BIN      path to the claude CLI (default: claude)
  CC_MODEL           model alias/name passed to claude (optional; else claude's default)
  CC_PERMISSION_MODE plan (default, propose-only) | acceptEdits | bypassPermissions | …
  CC_MANAGE_WORKTREE "1" → `git worktree add` the cc/<branch> for workspace tasks
  CC_TIMEOUT_SECONDS per-run wall-clock cap (default: 1800)
  CC_ALLOWED_TOOLS   comma/space tool allowlist passed to claude (optional)
  CC_DISALLOWED_TOOLS comma/space tool denylist passed to claude (optional)
  CC_ATTACH_RESULT   "1" → also post the result markdown as a task work product
  # CC6 autonomous guards (BOTH required; default OFF — do not set unless you mean it):
  CC_AUTONOMOUS          "1" enables the operator autonomous-exec guard #1
  CC_AUTONOMOUS_CONFIRM  "1" enables guard #2 (both → CC_PERMISSION_MODE honored)
"""
import json, os, subprocess, sys, threading, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cc_headless as cc

BASE = os.environ.get("MC_BASE_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.environ.get("MC_AGENT_TOKEN", "")
WORKDIR = os.environ.get("MC_WORKDIR", os.getcwd())
POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
CLAUDE_BIN = os.environ.get("CC_CLAUDE_BIN", "claude")
MODEL = os.environ.get("CC_MODEL", "") or None
PERMISSION_MODE = os.environ.get("CC_PERMISSION_MODE", "plan")
MANAGE_WORKTREE = os.environ.get("CC_MANAGE_WORKTREE", "") in ("1", "true", "yes")
TIMEOUT = int(os.environ.get("CC_TIMEOUT_SECONDS", "1800"))
ATTACH_RESULT = os.environ.get("CC_ATTACH_RESULT", "") in ("1", "true", "yes")
AUTONOMOUS = os.environ.get("CC_AUTONOMOUS", "") in ("1", "true", "yes")
AUTONOMOUS_CONFIRM = os.environ.get("CC_AUTONOMOUS_CONFIRM", "") in ("1", "true", "yes")


def _split_tools(v):
    return [t for t in (v or "").replace(",", " ").split() if t] or None


ALLOWED_TOOLS = _split_tools(os.environ.get("CC_ALLOWED_TOOLS", ""))
DISALLOWED_TOOLS = _split_tools(os.environ.get("CC_DISALLOWED_TOOLS", ""))

_secret_values = []  # raw secret strings, used to redact logs before they leave the host


# ─── HTTP ────────────────────────────────────────────────────────────────────

def _req(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if body is not None:  # Fastify 400s on an empty JSON body
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


def heartbeat(status="green", note=None):
    body = {"status": status}
    if note:
        body["note"] = note
    return _req("POST", "/api/agent/heartbeat", body)


def load_secrets():
    """Fetch this agent's scoped secrets and inject them as env vars for the
    `claude` child (e.g. ANTHROPIC_API_KEY). Values are also remembered so log
    lines are redacted before they are posted back."""
    code, data = _req("GET", "/api/agent/secrets")
    if code == 200 and isinstance(data, dict):
        secs = data.get("secrets", {}) or {}
        for k, v in secs.items():
            os.environ[str(k)] = str(v)
            _secret_values.append(str(v))
        if secs:
            print(f"  loaded {len(secs)} scoped secret(s) into env")


def post_log(run_id, lines, session_id=None, cost=None, tokens=None):
    if not run_id:
        return
    text = cc.redact("\n".join(l for l in lines if l), _secret_values)
    body = {}
    if text:
        body["log"] = text[:8000]
    if session_id:
        body["sessionState"] = session_id
    if cost is not None:
        body["costUsd"] = cost
    if tokens is not None:
        body["tokensUsed"] = tokens
    if body:
        _req("POST", f"/api/agent/runs/{run_id}/log", body)


# ─── The headless run ────────────────────────────────────────────────────────

def run_claude(prompt, cwd, resume=None):
    """Spawn a headless `claude -p` and stream its stream-json output. Returns
    (events, log_flushed). Fails closed: the permission mode is resolved through
    cc_headless so autonomous is impossible without both operator guards."""
    mode = cc.resolve_permission_mode(
        PERMISSION_MODE, autonomous_enabled=AUTONOMOUS, autonomous_confirmed=AUTONOMOUS_CONFIRM)
    argv = cc.build_claude_argv(
        prompt, claude_bin=CLAUDE_BIN, permission_mode=mode, model=MODEL,
        resume=resume, allowed_tools=ALLOWED_TOOLS, disallowed_tools=DISALLOWED_TOOLS)
    os.makedirs(cwd, exist_ok=True)
    proc = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    killed = {"flag": False}

    def _kill():
        killed["flag"] = True
        try:
            proc.kill()
        except Exception:
            pass

    timer = threading.Timer(TIMEOUT, _kill)
    timer.start()
    events = []
    try:
        for raw in proc.stdout:  # line-buffered stream-json
            ev = cc.parse_stream_json_line(raw)
            if ev is None:
                continue
            events.append(ev)
        proc.wait()
    finally:
        timer.cancel()
    if killed["flag"]:
        events.append({"type": "result", "subtype": "timeout", "is_error": True,
                       "result": f"claude run exceeded CC_TIMEOUT_SECONDS ({TIMEOUT}s) and was killed."})
    return events, mode


# ─── Task lifecycle ──────────────────────────────────────────────────────────

def process_one(task):
    tid = task["id"]
    title = str(task.get("title", ""))[:60]
    print(f"  ▶ claim {tid}  {title}")
    code, claim = _req("POST", f"/api/agent/tasks/{tid}/claim")
    if code not in (200, 201):
        print(f"    claim failed ({code}): {claim.get('error','')}")
        return
    run_id = (claim or {}).get("runId")
    resume = (claim or {}).get("sessionState")  # resume a prior claude session if any

    plan = cc.resolve_workdir(task, WORKDIR, manage_worktree=MANAGE_WORKTREE)
    cwd = plan["cwd"]
    if plan["gitPlan"]:
        for git_argv in plan["gitPlan"]:
            try:
                subprocess.run(git_argv, cwd=WORKDIR, capture_output=True, text=True, timeout=120)
            except Exception as e:
                print(f"    worktree setup note: {e}")

    prompt = cc.build_task_prompt(task)
    post_log(run_id, [f"$ {CLAUDE_BIN} -p … (permission-mode resolving, cwd={cwd})"], session_id=resume)

    events, mode = run_claude(prompt, cwd, resume=resume)

    # Flush human-readable log lines from the stream.
    log_lines = [l for l in (cc.event_log_line(e) for e in events) if l]
    result = cc.extract_result(events)
    post_log(run_id, [f"(permission-mode={mode})"] + log_lines,
             session_id=result.get("sessionId"), cost=result.get("costUsd"), tokens=result.get("tokensUsed"))

    # Optionally attach the result as a durable work product (markdown → vault).
    if ATTACH_RESULT and result.get("output"):
        md = f"# Claude Code result — {title or tid}\n\n{result['output']}\n"
        _req("POST", f"/api/agent/tasks/{tid}/attachment",
             {"name": f"cc-result-{tid[:8]}.md", "markdown": md[:60000]})

    body = {"output": cc.redact(result["output"], _secret_values)[:8000], "status": result["status"]}
    if run_id:
        body["runId"] = run_id
    if result.get("costUsd") is not None:
        body["costUsd"] = result["costUsd"]
    if result.get("tokensUsed") is not None:
        body["tokensUsed"] = result["tokensUsed"]
    rc, _ = _req("POST", f"/api/agent/tasks/{tid}/result", body)
    mark = "✓" if result["status"] == "done" else "✗"
    print(f"    {mark} {result['status']}  (result posted {rc}, mode={mode})")


def poll_once():
    code, data = _req("GET", "/api/agent/tasks?state=assigned")
    if code != 200:
        print(f"poll failed ({code}): {data.get('error','')}")
        heartbeat("amber")
        return 0
    tasks = data.get("tasks", [])
    for t in tasks:
        try:
            process_one(t)
        except Exception as e:
            print(f"  task error ({t.get('id')}): {e}", file=sys.stderr)
    heartbeat("green")
    return len(tasks)


def main():
    if not TOKEN:
        print("MC_AGENT_TOKEN is required", file=sys.stderr)
        sys.exit(2)
    heartbeat("green")
    load_secrets()
    resolved = cc.resolve_permission_mode(
        PERMISSION_MODE, autonomous_enabled=AUTONOMOUS, autonomous_confirmed=AUTONOMOUS_CONFIRM)
    autonomy = "AUTONOMOUS" if cc.is_autonomous_mode(resolved) else "propose-and-approve"
    print(f"7Ei MC claude-code adapter → {BASE}")
    print(f"  claude={CLAUDE_BIN} model={MODEL or '(default)'} permission-mode={resolved} [{autonomy}] workdir={WORKDIR}")
    if cc.is_autonomous_mode(resolved):
        print("  ⚠ AUTONOMOUS host execution is ON (both operator guards set). Commands still pass the CC5 denylist hook.")
    if "--once" in sys.argv:
        n = poll_once()
        print(f"processed {n} task(s)")
        return
    while True:
        try:
            poll_once()
        except KeyboardInterrupt:
            print("bye")
            return
        except Exception as e:
            print("loop error:", e, file=sys.stderr)
            heartbeat("amber")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
