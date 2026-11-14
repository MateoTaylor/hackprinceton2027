#!/usr/bin/env python3
"""Serve the visualization pages and data/ at http://localhost:8000.

Unlike `python -m http.server`, this binds to localhost only (so nobody on the hackathon Wi-Fi can
reach it) and serves only tools/visualization/ and data/. Dotfiles are refused everywhere, so .env
is never served, and neither is anything else in the repo.

  py tools/visualization/serve.py            # then open http://localhost:8000/
  py tools/visualization/serve.py --port 8001

URLs mirror the repo layout:
  /                                    -> redirects to the walk-through viewer
  /tools/visualization/index.html      walk-through viewer (photo vs 3D render)
  /tools/visualization/alignment.html  convention and alignment checks
  /data/<model_id>/...                 downloaded scans
"""
from __future__ import annotations

import argparse
import functools
import http.server
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent                 # tools/visualization
ROOT = HERE.parent.parent                              # repo root
HOME = "/" + HERE.relative_to(ROOT).as_posix() + "/"   # /tools/visualization/
ALLOWED_PREFIXES = (tuple(HERE.relative_to(ROOT).parts), ("data",))


def allowed(url_path: str) -> bool:
    """True only for paths inside an allowed folder, with no dotfiles or odd segments."""
    parts = [p for p in url_path.split("/") if p]
    if not any(tuple(parts[: len(prefix)]) == prefix for prefix in ALLOWED_PREFIXES):
        return False
    # "." also covers ".." traversal; "\\" and ":" cover Windows separators, drives and streams.
    return not any(p.startswith(".") or "\\" in p or ":" in p for p in parts)


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", HOME)
            self.end_headers()
            return None
        if not allowed(path):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        # Revalidate every time; unchanged files still come back as cheap 304s.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Serving the viewers at http://localhost:{args.port}/  (Ctrl+C to stop)", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
