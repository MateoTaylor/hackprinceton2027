#!/usr/bin/env python3
"""Serve viewer/ and data/ at http://localhost:8000 for the alignment viewer.

Unlike `python -m http.server`, this binds to localhost only (so nobody on the hackathon Wi-Fi can
reach it) and refuses dotfiles and anything outside viewer/ and data/ (so .env is never served).

  py tools/serve.py            # then open http://localhost:8000/
  py tools/serve.py --port 8001
"""
from __future__ import annotations

import argparse
import functools
import http.server
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOWED_TOP = {"viewer", "data"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/viewer/")
            self.end_headers()
            return None
        parts = [p for p in path.split("/") if p]
        if not parts or parts[0] not in ALLOWED_TOP or any(p.startswith(".") or "\\" in p for p in parts):
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
        print(f"Serving viewer at http://localhost:{args.port}/  (Ctrl+C to stop)", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
