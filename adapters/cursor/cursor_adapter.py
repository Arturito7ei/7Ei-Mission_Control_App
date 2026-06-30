#!/usr/bin/env python3
"""
7Ei Mission Control — Cursor runtime adapter (MCA-EXT, Phase 4).

Cursor is a human-in-the-IDE runtime, so this adapter does NOT execute tasks
itself. It bridges the app's task queue to a filesystem **inbox** that Cursor
(its agent or the human) works in:

  1. assigned task → claim → write a Markdown work order to MC_INBOX/TASK-<id>.md
  2. Cursor does the work in the repo, then writes MC_INBOX/TASK-<id>.result.md
  3. next poll → adapter detects the result → POST /result done → archive both

Stdlib only. Pair with the `.cursor/rules` snippet in this folder so Cursor's
agent knows to watch the inbox.

  MC_BASE_URL     app backend
  MC_AGENT_TOKEN  mca_...  (external agent, runtime=cursor)
  MC_INBOX        work-order dir (default: ./coordination/inbox)
  MC_POLL_SECONDS loop interval (default: 20)
"""
import json, os, re, sys, time, glob, shutil, urllib.request, urllib.error

BASE  = os.environ.get("MC_BASE_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.environ.get("MC_AGENT_TOKEN", "")
INBOX = os.environ.get("MC_INBOX", os.path.join(os.getcwd(), "coordination", "inbox"))
POLL  = int(os.environ.get("MC_POLL_SECONDS", "20"))
DONE_DIR = os.path.join(INBOX, "done")


def _req(method, path, body=None):
    req = urllib.request.Request(BASE + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


def heartbeat(status="green"):
    return _req("POST", "/api/agent/heartbeat", {"status": status})


def work_order(task):
    tid = task["id"]
    return (f"# MC Work Order — {tid}\n\n"
            f"- task: {task.get('title','')}\n"
            f"- status: in_progress\n"
            f"- priority: {task.get('priority','medium')}\n\n"
            f"## Input\n\n{task.get('input') or task.get('title') or ''}\n\n"
            f"## How to complete\n\n"
            f"Do the work in this repo. When finished, write your result (a short summary "
            f"of what you did + any output) to:\n\n"
            f"    {os.path.join(INBOX, 'TASK-' + tid + '.result.md')}\n\n"
            f"The MC adapter will detect it on its next poll and report the task done.\n")


def emit_orders():
    """Claim newly-assigned tasks and drop a work order for each."""
    code, data = _req("GET", "/api/agent/tasks?state=assigned")
    if code != 200:
        print(f"poll failed ({code}): {data.get('error','')}"); return
    for t in data.get("tasks", []):
        tid = t["id"]
        path = os.path.join(INBOX, f"TASK-{tid}.md")
        if os.path.exists(path):
            continue
        c, _ = _req("POST", f"/api/agent/tasks/{tid}/claim")
        if c not in (200, 201):
            print(f"  claim {tid} failed ({c})"); continue
        os.makedirs(INBOX, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(work_order(t))
        print(f"  ⮕ work order written: TASK-{tid}.md  ({t.get('title','')[:40]})")


_RES_RE = re.compile(r"TASK-(.+)\.result\.md$")


def collect_results():
    """Detect result files Cursor wrote and report them done."""
    n = 0
    for rp in glob.glob(os.path.join(INBOX, "TASK-*.result.md")):
        m = _RES_RE.search(os.path.basename(rp))
        if not m:
            continue
        tid = m.group(1)
        output = open(rp, encoding="utf-8").read().strip() or "(done by Cursor)"
        c, _ = _req("POST", f"/api/agent/tasks/{tid}/result", {"output": output[:8000], "status": "done"})
        print(f"  ✓ result posted for {tid} ({c})")
        if c in (200, 201):
            os.makedirs(DONE_DIR, exist_ok=True)
            for suffix in (".md", ".result.md"):
                src = os.path.join(INBOX, f"TASK-{tid}{suffix}")
                if os.path.exists(src):
                    shutil.move(src, os.path.join(DONE_DIR, f"TASK-{tid}{suffix}"))
            n += 1
    return n


def poll_once():
    emit_orders()
    collect_results()
    heartbeat("green")


def main():
    if not TOKEN:
        print("MC_AGENT_TOKEN is required", file=sys.stderr); sys.exit(2)
    print(f"7Ei MC cursor adapter → {BASE}  (inbox={INBOX})")
    os.makedirs(INBOX, exist_ok=True)
    heartbeat("green")
    if "--once" in sys.argv:
        poll_once(); return
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
