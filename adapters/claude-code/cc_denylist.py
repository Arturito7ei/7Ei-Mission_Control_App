"""Epic CC / CC5 — semantic shell-command allow/deny list (host-side twin).

The daemon-side mirror of backend/src/services/cc-denylist.ts. The guard hook
(cc_guard.py) imports `evaluate_command` so that, in the CC6 autonomous posture,
a denylisted command is REFUSED on the host and only a fully-allowlisted command
is allowed to run without a per-command approval. Keep this in sync with the TS
twin (like arturita-host/safety.mjs ↔ host-planner.ts).

Precedence is ALWAYS deny > allow > gate. Fail-closed: unknown ⇒ gate (never run).
Stdlib only (re).
"""
import re

# ── Denylist — catastrophic / self-protection / exfil ────────────────────────
# (category, regex). Tested case-insensitively against the whole command AND
# each shell segment.
_DENYLIST = [
    # Filesystem catastrophe
    ("fs-catastrophe", r"\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(/|~|/\*|\$HOME|\.\.)(\s|$)"),
    ("fs-catastrophe", r"\brm\s+-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*\s+/(\s|$)"),
    ("fs-catastrophe", r"\bfind\s+(/|~|\$HOME)\s+.*-delete"),
    ("fs-catastrophe", r"\b(shred|wipe)\b"),
    # Disk / partition / raw devices
    ("disk", r"\bdd\b[^\n]*\bof=/dev/"),
    ("disk", r"\bmkfs(\.[a-z0-9]+)?\b"),
    ("disk", r"\b(fdisk|parted|gpt)\b"),
    ("disk", r"\bdiskutil\s+(erase|partition|reformat)"),
    ("disk", r">\s*/dev/(sd|nvme|disk|hd)[a-z0-9]"),
    # Fork bomb
    ("resource", r":\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:"),
    # Privilege escalation / system control
    ("privilege", r"\b(sudo|doas)\b"),
    ("privilege", r"(^|\s)su\s+-?\s*(root|-)?(\s|$)"),
    ("system", r"\b(shutdown|reboot|halt|poweroff)\b"),
    ("system", r"\bchmod\s+(-[a-z]*\s+)*[0-7]*777[0-7]*\s+(-[a-z]*\s+)*(/|~)"),
    ("system", r"\bchmod\s+-[a-z]*r[a-z]*\s+[0-7]{3,4}\s+(/|~)"),
    ("system", r"\bchown\s+-[a-z]*r"),
    ("system", r"\bcsrutil\s+disable"),
    ("system", r"\bspctl\s+--master-disable"),
    ("system", r"\b(pfctl|iptables|ufw|nftables)\b"),
    ("system", r"\b(launchctl|systemctl)\s+(unload|disable|stop|remove)"),
    # Pipe-to-shell / remote code execution
    ("remote-exec", r"\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*|node|ruby|perl)\b"),
    ("remote-exec", r"\b(sh|bash|zsh)\s+-c\s+[\"']?\$\((curl|wget|fetch)"),
    ("remote-exec", r"\beval\s+[\"']?\$\((curl|wget|fetch)"),
    ("remote-exec", r"\bbase64\s+(-d|--decode)\b[^\n|]*\|\s*(sh|bash|zsh)"),
    # Reverse shells / netcat
    ("reverse-shell", r"\bnc\b[^\n]*\s-[a-z]*e\b"),
    ("reverse-shell", r"/dev/(tcp|udp)/"),
    ("reverse-shell", r"\bbash\s+-i\b[^\n]*(>&|\d>&)"),
    ("reverse-shell", r"\bsocat\b[^\n]*exec"),
    ("reverse-shell", r"\bmkfifo\b[^\n]*(nc|netcat|/dev/tcp)"),
    # Credential / secret exfiltration
    ("secret-exfil", r"(\.ssh\b|id_rsa|id_ed25519|\.aws/credentials|\.gnupg|\.env(\.| |$)|wallet\.dat|keystore|\.metamask|utc--)"),
    ("secret-exfil", r"\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain)"),
    ("secret-exfil", r"\b(cat|less|more|head|tail|strings)\b[^\n]*(_history|\.history|\.netrc)"),
    # History / log tampering
    ("anti-forensics", r"\bhistory\s+-c\b"),
    ("anti-forensics", r"\bunset\s+HISTFILE\b"),
]

_DEFAULT_ALLOWLIST = [
    r"^git\s+(status|diff|log|show|branch|remote|rev-parse|describe|fetch|config\s+--get)\b",
    r"^ls\b", r"^pwd$", r"^echo\b", r"^cat\s+[^|>]*$", r"^head\b", r"^tail\b", r"^wc\b",
    r"^grep\b", r"^rg\b", r"^find\s+[^|]*-(name|type|path)\b", r"^tree\b", r"^stat\b", r"^file\b",
    r"^npm\s+(test|run\s+test|run\s+build|run\s+lint|run\s+typecheck|ci|install|ls)\b",
    r"^pnpm\s+(test|build|install|lint)\b", r"^yarn\s+(test|build|install|lint)\b",
    r"^node\s+--test\b", r"^npx\s+tsc\b", r"^tsc\b", r"^jest\b", r"^vitest\b",
    r"^python[0-9.]*\s+-m\s+(pytest|unittest)\b", r"^pytest\b", r"^ruff\b", r"^mypy\b",
    r"^cargo\s+(build|test|check|clippy|fmt)\b", r"^go\s+(build|test|vet|fmt)\b",
]

_SEGMENT_SPLIT = re.compile(r"\s*(?:&&|\|\||;|\||&|\n)\s*")


def _normalize(cmd):
    return re.sub(r"\s+", " ", str(cmd or "")).strip()


def split_segments(cmd):
    return [s for s in (x.strip() for x in _SEGMENT_SPLIT.split(_normalize(cmd))) if s]


def _compile(sources):
    out = []
    for s in sources or []:
        try:
            out.append(re.compile(s, re.IGNORECASE))
        except re.error:
            pass
    return out


def evaluate_command(command, policy=None):
    """Classify a shell command → {'decision': deny|allow|gate, 'reason', 'category'}.
    Fail-closed: empty ⇒ gate. Precedence deny > allow > gate."""
    policy = policy or {}
    cmd = _normalize(command)
    if not cmd:
        return {"decision": "gate", "reason": "empty/blank command — gated (fail-closed)", "category": "empty"}

    segments = split_segments(cmd)
    rules = [(cat, re.compile(pat, re.IGNORECASE)) for cat, pat in _DENYLIST]
    for pat in _compile(policy.get("extraDenylist")):
        rules.append(("operator", pat))

    # 1. deny wins
    for cat, rx in rules:
        if rx.search(cmd) or any(rx.search(s) for s in segments):
            return {"decision": "deny", "reason": _reason_for(cat), "category": cat}

    # 2. allow — every segment must match an allow pattern
    allow = _compile(policy.get("allowlist") if policy.get("allowlist") is not None else _DEFAULT_ALLOWLIST)
    if allow and all(any(rx.search(s) for rx in allow) for s in segments):
        return {"decision": "allow", "reason": "every segment matches the allowlist", "category": "allowlisted"}

    # 3. gate
    return {"decision": "gate", "reason": "not denylisted and not fully allowlisted — requires approval", "category": "gated"}


def _reason_for(category):
    return {
        "fs-catastrophe": "catastrophic filesystem operation",
        "disk": "raw disk / partition operation",
        "resource": "resource-exhaustion (fork bomb)",
        "privilege": "privilege escalation",
        "system": "system / security-control change",
        "remote-exec": "download piped into a shell (remote code execution)",
        "reverse-shell": "reverse-shell pattern",
        "secret-exfil": "touches a credential / secret store",
        "anti-forensics": "history / log tampering",
        "operator": "operator denylist",
    }.get(category, "denylisted")
