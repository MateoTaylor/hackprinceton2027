"""Qwen-Image-2.1 on one view, with optional context pictures (the panorama variants).

The same sd-cli command as steps.generate, plus one `-r` per context picture. The runner enlarges
every input to the output size unless `--ref-image-args resize_before_vae=0` is passed (qwen_test
README); with it, context pictures stay at their own size. The caller holds the GPU lock.
"""
import re
import subprocess

from PIL import Image

from run_qwen import MODELS, QUANTS, SD_CLI, VAE, VISION, VramMonitor

CONTEXT_PX = 512          # long side of a context picture; qwen_test found 512 and 768 alike, 512 is faster
MULTIPLE = 32             # Qwen-Image-2.1 refuses reference pictures whose sides are not multiples of 32


def _fit(side, multiple=MULTIPLE):
    return max(multiple, round(side / multiple) * multiple)


def shrunk(src, dst, side=CONTEXT_PX):
    img = Image.open(src).convert("RGB")
    scale = side / max(img.size)
    img.resize((_fit(img.size[0] * scale), _fit(img.size[1] * scale)), Image.LANCZOS).save(dst)
    return dst


def generate(view, prompt, preset, run, refs=(), tag="raw"):
    q = QUANTS[preset.quant]
    w, h = Image.open(view).size
    raw = run / f"{tag}.png"
    if refs:
        # With resize_before_vae=0 the view goes in at its own size too, so it must be a multiple of 32
        # (720 is not). Without refs the runner resizes it and returns 736 for 720 by itself.
        w, h = -(-w // MULTIPLE) * MULTIPLE, -(-h // MULTIPLE) * MULTIPLE
        fitted = run / f"{tag}_view.png"
        Image.open(view).convert("RGB").resize((w, h), Image.LANCZOS).save(fitted)
        view = fitted
    cmd = [str(SD_CLI), "--diffusion-model", str(MODELS / q["diffusion"]), "--vae", str(MODELS / VAE),
           "--llm", str(MODELS / q["llm"]), "--llm_vision", str(MODELS / VISION), "-r", str(view)]
    for r in refs:
        cmd += ["-r", str(r)]
    cmd += ["-p", prompt, "--cfg-scale", str(preset.cfg), "--sampling-method", "euler", "--steps", str(preset.steps),
            "-W", str(w), "-H", str(h), "--seed", str(preset.seed), "--flash-attn", "off,diffusion=on", "-v",
            "-o", str(raw)]
    if refs:
        cmd += ["--ref-image-args", "resize_before_vae=0"]
    if raw.exists():
        raw.unlink()
    monitor = VramMonitor()
    monitor.start()
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    monitor.stop()
    log = f"PROMPT: {prompt}\nREFS: {[str(r) for r in refs]}\n\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    (run / f"{tag}.log").write_text(log, encoding="utf-8")
    if not raw.exists():
        raise RuntimeError(f"sd-cli wrote no image (exit {proc.returncode}), see {run / (tag + '.log')}")
    info = {"vram_peak_mb": monitor.peak, "size": [w, h], "refs": len(refs)}
    sampling = re.findall(r"sampling completed, taking ([\d.]+)s", log)
    if sampling:
        info["sampling_s"] = float(sampling[-1])
    return raw, info
