"""Settings for the edit API, read from the repo's .env. Never logs or returns a value read here."""
from __future__ import annotations

import ipaddress
import os
import re
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT = DATA / "edit_api"
JOBS = OUT / "jobs"
KIT = ROOT / "kit" / "costar-hackathon-kit"
FETCHER = ROOT / "tools" / "fetch_matterport.py"
ENV_FILE = ROOT / ".env"

PORT = 2026
PIPELINE_URL = "http://127.0.0.1:2025"     # the edit graph's Agent Server; never exposed
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_QUEUED = 8                             # more than this waiting and POST /edits answers `busy`
FETCH_TIMEOUT_S = 1200
RESOLUTION = "2k"


def load_env() -> None:
    """KEY=VALUE lines from .env, without overriding the environment (as fetch_matterport.py)."""
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def make_token() -> bool:
    """Append a random EDIT_API_TOKEN to .env if it has none. Returns True if one was written.
    The value is never printed."""
    load_env()
    if os.environ.get("EDIT_API_TOKEN"):
        return False
    text = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.is_file() else ""
    if re.search(r"^\s*EDIT_API_TOKEN\s*=", text, re.M):
        lines = [ln for ln in text.splitlines() if not re.match(r"^\s*EDIT_API_TOKEN\s*=", ln)]
        text = "\n".join(lines) + "\n"
    if text and not text.endswith("\n"):
        text += "\n"
    ENV_FILE.write_text(text + f"EDIT_API_TOKEN={secrets.token_urlsafe(32)}\n", encoding="utf-8")
    return True


class Settings:
    def __init__(self) -> None:
        load_env()
        self.token = os.environ.get("EDIT_API_TOKEN", "")
        self.host = os.environ.get("EDIT_API_HOST", "").strip() or "127.0.0.1"
        self.allow_text = [a.strip() for a in os.environ.get("EDIT_API_ALLOW", "").split(",") if a.strip()]
        self.allow_any = "*" in self.allow_text
        self.allow_nets = []
        for entry in ["127.0.0.1", "::1", *[a for a in self.allow_text if a != "*"]]:
            try:
                self.allow_nets.append(ipaddress.ip_network(entry, strict=False))
            except ValueError:
                self.allow_nets.append(None)             # reported by check()
        self.cors = [o.strip() for o in os.environ.get("EDIT_API_CORS", "").split(",") if o.strip()]

    def allows(self, address: str) -> bool:
        """This PC, `*` (any address: the token is the only gate), an address or a CIDR range."""
        if self.allow_any:
            return True
        try:
            addr = ipaddress.ip_address(address)
        except ValueError:
            return False
        return any(net is not None and addr in net for net in self.allow_nets)

    def describe_allow(self) -> str:
        return "any address (token only)" if self.allow_any else ", ".join(["127.0.0.1", *self.allow_text])

    def check(self) -> list[str]:
        """Reasons the server must not start."""
        problems = []
        if len(self.token) < 24:
            problems.append("EDIT_API_TOKEN is missing or shorter than 24 characters "
                            "(run `server.py --make-token` to write one into .env)")
        try:
            addr = ipaddress.ip_address(self.host)
            if addr.is_unspecified:
                problems.append("EDIT_API_HOST must be one address, never 0.0.0.0 or ::")
        except ValueError:
            problems.append("EDIT_API_HOST must be an IP address")
        if None in self.allow_nets:
            problems.append("EDIT_API_ALLOW must list IP addresses or CIDR ranges (or *), comma-separated")
        return problems
