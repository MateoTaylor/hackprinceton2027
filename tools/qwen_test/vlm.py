"""Qwen3-VL as a chat model (reads images, writes text), served by llama.cpp on this machine only.

  with Server() as vlm:
      answer = vlm.ask([image_path, ...], "question", schema={...json schema...})

The same GGUF file that sd-cli uses as the image model's text encoder is loaded here as a normal
chat model. The server listens on 127.0.0.1 and is stopped when the `with` block ends, which frees
its GPU memory before the image model runs.

  python vlm.py IMAGE [IMAGE ...] --ask "what is in this image?"     quick manual test
"""
import argparse
import base64
import io
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
SERVER = HERE / "bin" / "llama" / "llama-server.exe"
CHAT = {"q4": "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf", "q8": "Qwen3-VL-8B-Instruct-Q8_0.gguf"}
VISION = "Qwen3-VL-8B-Instruct-mmproj-F16.gguf"


def data_url(image, max_side=1024):
    img = image if isinstance(image, Image.Image) else Image.open(image)
    img = img.convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


class Server:
    def __init__(self, quant="q4", port=8081, ctx=8192, log=None, extra=()):
        self.quant, self.port, self.ctx, self.extra = quant, port, ctx, list(extra)
        self.url = f"http://127.0.0.1:{port}"
        self.log_path = Path(log) if log else HERE / "outputs" / "llama-server.log"
        self.proc = None
        self.load_s = None

    def __enter__(self):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [str(SERVER), "-m", str(MODELS / CHAT[self.quant]), "--mmproj", str(MODELS / VISION),
               "-ngl", "all", "-c", str(self.ctx), "--host", "127.0.0.1", "--port", str(self.port), "--no-webui",
               *self.extra]
        t0 = time.time()
        self.proc = subprocess.Popen(cmd, stdout=open(self.log_path, "w", encoding="utf-8"), stderr=subprocess.STDOUT)
        while time.time() - t0 < 240:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited, see {self.log_path}")
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=2) as r:
                    if r.status == 200:
                        self.load_s = round(time.time() - t0, 1)
                        return self
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(0.5)
        self.__exit__(None, None, None)
        raise RuntimeError(f"llama-server did not become ready, see {self.log_path}")

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def ask(self, images, text, schema=None, max_tokens=700, temperature=0.0):
        """One question about some images. With `schema` the answer is forced to be JSON of that shape
        and is returned parsed; otherwise the answer text is returned. Also returns timing info."""
        content = [{"type": "image_url", "image_url": {"url": data_url(i)}} for i in images]
        content.append({"type": "text", "text": text})
        body = {"messages": [{"role": "user", "content": content}], "max_tokens": max_tokens,
                "temperature": temperature, "seed": 0}
        if schema:
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "answer", "strict": True, "schema": schema}}
        req = urllib.request.Request(self.url + "/v1/chat/completions", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=600) as r:
            reply = json.loads(r.read())
        out = reply["choices"][0]["message"]["content"]
        info = {"seconds": round(time.time() - t0, 1), **{k: reply.get("usage", {}).get(k)
                                                          for k in ("prompt_tokens", "completion_tokens")}}
        if not schema:
            return out, info
        try:
            return json.loads(out), info
        except json.JSONDecodeError:
            raise RuntimeError(f"the model's JSON was cut off or malformed ({info}):\n{out}") from None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--ask", required=True)
    ap.add_argument("--quant", default="q4", choices=list(CHAT))
    args = ap.parse_args()
    with Server(args.quant) as vlm:
        print(f"model loaded in {vlm.load_s} s")
        answer, info = vlm.ask(args.images, args.ask)
        print(answer)
        print(info)


if __name__ == "__main__":
    main()
