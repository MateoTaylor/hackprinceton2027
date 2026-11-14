"""One GPU, one lock. The three local models do not fit in 16 GB together, so they take turns.

  with gpu.vlm(preset) as server:   the VLM is loaded for the block and freed after it
  with gpu.exclusive():             SAM or the image model has the card to itself

The lock is a file lock, so it also holds between processes on this PC: the Agent Server, a
command-line run and another agent's tests wait for each other instead of running out of memory
or fighting over the VLM's port. It only covers code that goes through this module.
"""
import atexit
import os
import sys
import threading
import time
from contextlib import contextmanager

from edit_agent.config import RUNS  # also puts tools/qwen_test on the import path
from vlm import Server

LOCK_FILE = RUNS.parent / "gpu.lock"
_THREADS = threading.RLock()
_depth = 0
_fd = None
_running = None


def _try_lock(fd):
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def _unlock(fd):
    if os.name == "nt":
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)


@contextmanager
def exclusive():
    """Hold the GPU. Waits for other threads and for other processes; may be nested."""
    global _depth, _fd
    with _THREADS:
        if _depth == 0:
            LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
            _fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT)     # the OS frees the lock if this process dies
            told = False
            while not _try_lock(_fd):
                if not told:
                    print("waiting for the GPU: another process on this PC is using it", file=sys.stderr, flush=True)
                    told = True
                time.sleep(0.5)
        _depth += 1
        try:
            yield
        finally:
            _depth -= 1
            if _depth == 0:
                _unlock(_fd)
                os.close(_fd)
                _fd = None


@contextmanager
def vlm(preset, log=None):
    global _running
    with exclusive():
        server = Server(quant=preset.quant, ctx=preset.vlm_ctx, log=log,
                        extra=["--image-min-tokens", str(preset.vlm_image_tokens)])
        server.__enter__()
        _running = server
        try:
            yield server
        finally:
            server.__exit__(None, None, None)
            _running = None


@atexit.register
def _stop():
    if _running is not None:
        _running.__exit__(None, None, None)
