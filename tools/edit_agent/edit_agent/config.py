"""Presets for the scan edit agent. Every setting lives here; nothing is remembered between runs.

A run names one preset. Each run writes to data/edit_agent/runs/<run>/ (git-ignored, local only).
"""
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
QWEN = ROOT / "tools" / "qwen_test"               # model runners, weights and binaries
RUNS = ROOT / "data" / "edit_agent" / "runs"

if str(QWEN) not in sys.path:                     # vlm.py, run_qwen.py and pano.py are imported from there
    sys.path.insert(0, str(QWEN))


@dataclass(frozen=True)
class Role:
    """Which chat model plays a role. "local" is the llama.cpp server that this PC starts on demand."""
    provider: str = "local"                       # "local" or "anthropic"
    model: str = "qwen3-vl-8b"


@dataclass(frozen=True)
class Limits:
    """Loose on purpose: the check is there to catch glaring problems, not to grade the edit."""
    wrong_picture_drift: float = 40.0             # clean edits drift 9-19, a returned reference picture 60-74
    unchanged_inside: float = 5.0                 # the masked area changed less than this: nothing was removed
    border_step: float = 12.0                     # tone step at the paste border: clean pastes 4-8, visible borders 12 and up
    report_severity: int = 2                      # VLM findings below this are kept as notes only
    # The item's "effect": where the image model changed the smooth brightness in one piece with the item
    # (its shadow, reflection or glow). Brightness is on the 0-255 scale.
    effect_sigmas: float = 4.0                    # a change counts at this many times the picture's own drift ...
    effect_min: float = 10.0                      # ... and at least this much
    effect_max_share: float = 0.25                # joined to the item over more of the picture: the scene was relit, ignore it
    effect_left: float = 0.001                    # share of the picture the model cleaned up but the paste kept
    # scouting (scout.py): edges outside the item that vanished or appeared. First guesses from 28 runs.
    scout_edge: float = 4.0                       # change in edge energy that counts (a deleted baseboard measures 8)
    scout_min_share: float = 0.0004               # smaller regions than this share of the picture are dropped
    scout_regions: int = 3                        # at most this many regions go on to a closer look
    restore_max_share: float = 0.08               # a restore that grows past this share of the picture stays in its boxes


@dataclass(frozen=True)
class Preset:
    # working image: long side in pixels. Both sides are rounded to a multiple of 16.
    work_px: int = 1024
    # image model (Qwen-Image-2.1 through sd-cli)
    quant: str = "q4"
    steps: int = 20
    cfg: float = 6.0
    seed: int = 42
    # VLM (Qwen3-VL through llama.cpp). A 1024 px image is 1024 tokens, 768 px is 576, 512 px is 256.
    vlm_px: int = 1024                            # long side of the images sent to it
    vlm_image_tokens: int = 1024                  # lower bound of tokens per image
    vlm_ctx: int = 8192
    # mask and paste, as shares of the working image's long side
    mask_grow: float = 0.006
    feather: float = 0.006
    paste_grow_pct: int = 100                     # paste a mask this much larger than the item, tone-matched
    tone_match: bool = True
    follow_change: bool = True                    # also paste the item's effect, however far it reaches (a long shadow)
    max_repairs: int = 1                          # second passes after the first; more than two passes is the exception
    # `eyes` is the model that sees pixels. It must stay local.
    eyes: Role = field(default_factory=Role)
    limits: Limits = field(default_factory=Limits)


PRESETS = {
    "quality": Preset(),
    "fast": Preset(work_px=768, vlm_px=768, vlm_image_tokens=576),
    "720": Preset(work_px=720, vlm_px=720, vlm_image_tokens=484),     # 720 px is 22.5 tokens wide: 22 x 22 is the floor
    "draft": Preset(work_px=512, vlm_px=512, vlm_image_tokens=256, steps=12),
}
DEFAULT_PRESET = "720"       # Mateo, 2026-11-14: 720 px is the working size (half the time of `quality`)
