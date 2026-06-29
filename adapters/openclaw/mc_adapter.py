#!/usr/bin/env python3
"""
7Ei Mission Control — external runtime adapter (MCA-EXT, Phase 2).

A tiny poll loop that lets a self-hosted runtime (OpenClaw/MiniMax on the Mac
mini, Cursor, or any custom agent) act as a Mission Control agent: it claims
tasks the app assigned to it, executes them with the host's own tools, and
posts results + heartbeats back over the agent-facing API.

Stdlib only (urllib, json, subprocess) — no pip install. Configure via env or
an env file (see mc.env.example). The agent token is issued once by
`POST /api/orgs/:orgId/agents/external`.

  MC_BASE_URL       e.g. https://7ei-backend.fly.dev   (or http://localhost:3001)
  MC_AGENT_TOKEN    mca_...                             (shown once at onboarding)
  MC_WORKDIR        working dir for shell tasks         (default: cwd)
  MC_ALLOW_SHELL    "1" to let tasks run as shell       (default: off)
  MC_POLL_SECONDS   loop interval                       (default: 20)
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional completion pings
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

BASE   = os.environ.get("MC_BASE_URL", "http://localhost:3001").rstrip("/")
TOKEN  = os.environ.get("MC_AGENT_TOKEN", "")
WORKDIR = os.environ.get("MC_WORKDIR", os.getcwd())
ALLOW_SHELL = os.environ.get("MC_ALLOW_SHELL", "") in ("1", "true", "yes")
POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT  = os.environ.get("TELEGRAM_CHAT_ID", "")


def _req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data is not None:  # only when a JSON body is actually sent (Fastify 400s on empty json body)
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:  # network / DNS / timeout
        return 0, {"error": str(e)}


def heartbeat(status="green", note=None):
    body = {"status": status}
    if note:
        body["note"] = note
    return _req("POST", "/api/agent/heartbeat", body)


def telegram(text):
    if not (TG_TOKEN and TG_CHAT):
        return
    try:
        body = json.dumps({"chat_id": TG_CHAT, "text": text}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            data=body, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        print("  telegram ping failed:", e, file=sys.stderr)


def execute(task):
    """Run a task with the host's tools. Default executor = shell (gated).
    Replace/extend this to hand off to the full OpenClaw/MiniMax brain."""
    cmd = (task.get("input") or task.get("title") or "").strip()
    if not cmd:
        return "failed", "empty task input"
    if not ALLOW_SHELL:
        return "failed", "shell execution disabled (set MC_ALLOW_SHELL=1 to enable)"
    try:
        os.makedirs(WORKDIR, exist_ok=True)
        proc = subprocess.run(cmd, shell=True, cwd=WORKDIR, capture_output=True,
                              text=True, timeout=600)
        out = (proc.stdout + proc.stderr).strip()
        return ("done" if proc.returncode == 0 else "failed",
                out or f"(exit {proc.returncode}, no output)")
    except subprocess.TimeoutExpired:
        return "failed", "task timed out after 600s"
    except Exception as e:
        return "failed", f"executor error: {e}"


def process_one(task):
    tid = task["id"]
    title = task.get("title", "")[:60]
    print(f"  ▶ claim {tid}  {title}")
    code, _ = _req("POST", f"/api/agent/tasks/{tid}/claim")
    if code not in (200, 201):
        print(f"    claim failed ({code})"); return
    status, output = execute(task)
    code, _ = _req("POST", f"/api/agent/tasks/{tid}/result",
                   {"output": output[:8000], "status": status})
    mark = "✓" if status == "done" else "✗"
    print(f"    {mark} {status}  ({code})")
    telegram(f"{mark} MC task {status}: {title}\n{output[:300]}")


def poll_once():
    code, data = _req("GET", "/api/agent/tasks?state=assigned")
    if code != 200:
        print(f"poll failed ({code}): {data.get('error','')}"); heartbeat("amber"); return 0
    tasks = data.get("tasks", [])
    for t in tasks:
        process_one(t)
    heartbeat("green")
    return len(tasks)


def main():
    if not TOKEN:
        print("MC_AGENT_TOKEN is required", file=sys.stderr); sys.exit(2)
    once = "--once" in sys.argv
    print(f"7Ei MC adapter → {BASE}  (shell={'on' if ALLOW_SHELL else 'off'}, workdir={WORKDIR})")
    heartbeat("green")
    if once:
        n = poll_once(); print(f"processed {n} task(s)"); return
    while True:
        try:
            poll_once()
        except KeyboardInterrupt:
            print("bye"); return
        except Exception as e:
            print("loop error:", e, file=sys.stderr); heartbeat("amber")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
