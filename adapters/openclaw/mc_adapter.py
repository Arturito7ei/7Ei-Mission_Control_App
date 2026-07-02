#!/usr/bin/env python3
"""
7Ei Mission Control — external runtime adapter (MCA-EXT, Phase 2 / 2.1).

A tiny poll loop that lets a self-hosted runtime (OpenClaw/MiniMax on the Mac
mini, Cursor, or any custom agent) act as a Mission Control agent: it claims
tasks the app assigned to it, executes them — either as a raw shell command or
by handing them to the agent's LLM brain (MiniMax / any OpenAI-compatible model)
with a shell tool loop — and posts results + heartbeats over the agent API.

Stdlib only (urllib, json, subprocess) — no pip install.

  MC_BASE_URL       app backend, e.g. https://7ei-backend.fly.dev
  MC_AGENT_TOKEN    mca_...  (shown once at onboarding)
  MC_WORKDIR        working dir for shell tasks (default: cwd)
  MC_ALLOW_SHELL    "1" to allow shell execution (default: off)
  MC_EXECUTOR       auto | shell | llm   (default: auto → llm if MC_LLM_API_KEY set, else shell)
  MC_POLL_SECONDS   loop interval (default: 20)
  MC_MAX_STEPS      max brain↔tool steps (default: 4)
  # LLM brain (OpenAI-compatible chat completions):
  MC_LLM_BASE_URL   e.g. https://api.minimax.io/v1
  MC_LLM_API_KEY    provider key
  MC_LLM_MODEL      e.g. MiniMax-Text-01
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional completion pings
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error

BASE    = os.environ.get("MC_BASE_URL", "http://localhost:3001").rstrip("/")
TOKEN   = os.environ.get("MC_AGENT_TOKEN", "")
WORKDIR = os.environ.get("MC_WORKDIR", os.getcwd())
ALLOW_SHELL = os.environ.get("MC_ALLOW_SHELL", "") in ("1", "true", "yes")
POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
MAX_STEPS = int(os.environ.get("MC_MAX_STEPS", "4"))
EXECUTOR = os.environ.get("MC_EXECUTOR", "auto")
LLM_BASE  = os.environ.get("MC_LLM_BASE_URL", "").rstrip("/")
LLM_KEY   = os.environ.get("MC_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("MC_LLM_MODEL", "MiniMax-Text-01")
LLM_MAX_TOKENS = int(os.environ.get("MC_LLM_MAX_TOKENS", "1024"))  # some hosts (e.g. NVIDIA NIM minimax-m3) return empty choices without this
HTTP_URL   = os.environ.get("MC_HTTP_URL", "")        # MC_EXECUTOR=http → POST tasks here
HTTP_HEADER = os.environ.get("MC_HTTP_HEADER", "")    # optional "Name: value" auth header for the webhook
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT  = os.environ.get("TELEGRAM_CHAT_ID", "")

_me = None  # cached agent identity


def _req(method, path, body=None):
    req = urllib.request.Request(BASE + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if body is not None:  # Fastify 400s on empty json body
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


def whoami():
    global _me
    if _me is None:
        _, data = _req("GET", "/api/agent/me")
        _me = data.get("agent", {}) if isinstance(data, dict) else {}
    return _me


def telegram(text):
    if not (TG_TOKEN and TG_CHAT):
        return
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            data=json.dumps({"chat_id": TG_CHAT, "text": text}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        print("  telegram ping failed:", e, file=sys.stderr)


# ─── executors ──────────────────────────────────────────────────────────────

def shell_run(cmd):
    """Run a shell command in MC_WORKDIR; return (rc, combined_output)."""
    os.makedirs(WORKDIR, exist_ok=True)
    p = subprocess.run(cmd, shell=True, cwd=WORKDIR, capture_output=True, text=True, timeout=600)
    return p.returncode, (p.stdout + p.stderr).strip()


def shell_execute(task):
    cmd = (task.get("input") or task.get("title") or "").strip()
    if not cmd:
        return "failed", "empty task input"
    if not ALLOW_SHELL:
        return "failed", "shell execution disabled (set MC_ALLOW_SHELL=1)"
    try:
        rc, out = shell_run(cmd)
        return ("done" if rc == 0 else "failed", out or f"(exit {rc}, no output)")
    except subprocess.TimeoutExpired:
        return "failed", "task timed out after 600s"
    except Exception as e:
        return "failed", f"executor error: {e}"


_BASH_RE = re.compile(r"```(?:bash|sh)\s*\n(.*?)```", re.DOTALL)


def _extract_bash(text):
    m = _BASH_RE.search(text or "")
    return m.group(1).strip() if m else None


def llm_chat(messages):
    """OpenAI-compatible chat completion → assistant content string.

    Credentials are read from os.environ at call time (not import time) so a key
    injected by load_secrets() from the encrypted D4 secret store is picked up —
    no plaintext MC_LLM_API_KEY needs to live in mc.env on disk.
    """
    base = os.environ.get("MC_LLM_BASE_URL", LLM_BASE).rstrip("/")
    key = os.environ.get("MC_LLM_API_KEY", LLM_KEY)
    model = os.environ.get("MC_LLM_MODEL", LLM_MODEL)
    try:
        max_tokens = int(os.environ.get("MC_LLM_MAX_TOKENS", str(LLM_MAX_TOKENS)))
    except ValueError:
        max_tokens = LLM_MAX_TOKENS
    if not (base and key):
        raise RuntimeError("MC_LLM_BASE_URL / MC_LLM_API_KEY not configured")
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode())
    return data["choices"][0]["message"]["content"]


def llm_execute(task):
    """Hand the task to the agent's LLM brain with a gated shell tool loop."""
    me = whoami()
    name = me.get("name", "Agent")
    role = me.get("role", "agent")
    runtime = me.get("runtime", "custom")
    tor = me.get("termsOfReference") or ""
    system = (
        f"You are {name}, {role} at 7Ei, operating as an autonomous Mission Control "
        f"agent on a {runtime} runtime. {tor}\n"
        "Complete the user's task. To run a shell command in your working directory, "
        "reply with EXACTLY ONE fenced ```bash code block and nothing else; the runtime "
        "executes it and replies with 'OBSERVATION:' + output. When finished, reply with a "
        "concise final answer and NO bash block."
    )
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": task.get("input") or task.get("title") or ""}]
    last = ""
    try:
        for _ in range(MAX_STEPS):
            content = llm_chat(messages)
            last = content
            bash = _extract_bash(content)
            if not bash:
                return "done", content.strip()
            if not ALLOW_SHELL:
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": "OBSERVATION: shell disabled; answer without it."})
                continue
            rc, out = shell_run(bash)
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": f"OBSERVATION: (exit {rc})\n{out[:4000]}"})
        return "done", (last.strip() or "(max steps reached)")
    except Exception as e:
        return "failed", f"llm executor error: {e}"


def http_execute(task):
    """Forward the task to a bring-your-own HTTP bot and use its reply as the result.
    POSTs {id,title,input} to MC_HTTP_URL. Accepts a JSON {output,status?} reply or plain text."""
    if not HTTP_URL:
        return "failed", "MC_HTTP_URL not configured"
    headers = {"Content-Type": "application/json"}
    if HTTP_HEADER and ":" in HTTP_HEADER:
        k, v = HTTP_HEADER.split(":", 1)
        headers[k.strip()] = v.strip()
    payload = {"id": task.get("id"), "title": task.get("title"), "input": task.get("input") or ""}
    req = urllib.request.Request(HTTP_URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
    except Exception as e:
        return "failed", f"http executor error: {e}"
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return (data.get("status") or "done"), str(data.get("output") or data.get("result") or raw)
    except Exception:
        pass
    return "done", raw


def choose_executor():
    if EXECUTOR == "shell":
        return shell_execute
    if EXECUTOR == "llm":
        return llm_execute
    if EXECUTOR == "http":
        return http_execute
    # auto — read the key from env at call time so a secret injected by
    # load_secrets() counts (falls back to the import-time module global)
    return llm_execute if os.environ.get("MC_LLM_API_KEY", LLM_KEY) else shell_execute


def execute(task):
    return choose_executor()(task)


# ─── poll loop ──────────────────────────────────────────────────────────────

def process_one(task):
    tid = task["id"]
    title = task.get("title", "")[:60]
    print(f"  ▶ claim {tid}  {title}")
    code, _ = _req("POST", f"/api/agent/tasks/{tid}/claim")
    if code not in (200, 201):
        print(f"    claim failed ({code})"); return
    status, output = execute(task)
    code, _ = _req("POST", f"/api/agent/tasks/{tid}/result", {"output": output[:8000], "status": status})
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


def load_secrets():
    """Fetch this agent's scoped secrets (MCA-PC D4) and inject them as env vars."""
    code, data = _req("GET", "/api/agent/secrets")
    if code == 200 and isinstance(data, dict):
        secs = data.get("secrets", {}) or {}
        for k, v in secs.items():
            os.environ[str(k)] = str(v)
        if secs:
            print(f"  loaded {len(secs)} scoped secret(s) into env")


def main():
    if not TOKEN:
        print("MC_AGENT_TOKEN is required", file=sys.stderr); sys.exit(2)
    # Load scoped secrets first so an injected MC_LLM_API_KEY influences auto-executor selection.
    heartbeat("green")
    load_secrets()
    _ex = choose_executor()
    mode = {id(llm_execute): "llm", id(shell_execute): "shell", id(http_execute): "http"}.get(id(_ex), "auto")
    print(f"7Ei MC adapter → {BASE}  (executor={mode}, shell={'on' if ALLOW_SHELL else 'off'}, workdir={WORKDIR})")
    if "--once" in sys.argv:
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
