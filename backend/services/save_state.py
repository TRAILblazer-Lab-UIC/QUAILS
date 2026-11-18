"""Checkpoint/resume manager for analysis blocks."""

import os
import json


def load_state(block_dir):
    """Load save state for a block, or return empty state."""
    path = os.path.join(block_dir, "save_state.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"completed_count": 0}


def save_state(block_dir, state):
    """Save checkpoint state for a block."""
    path = os.path.join(block_dir, "save_state.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def clear_state(block_dir):
    """Remove save state (for fresh re-run)."""
    path = os.path.join(block_dir, "save_state.json")
    if os.path.exists(path):
        os.remove(path)


def _read(block_dir):
    path = os.path.join(block_dir, "save_state.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _write(block_dir, state):
    os.makedirs(block_dir, exist_ok=True)
    with open(os.path.join(block_dir, "save_state.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def mark_complete(block_dir, config_hash=None):
    """Mark a block's analysis as fully completed.

    Records the completion time (used to tie human-review approvals to this
    exact run) and a hash of the block settings (used to detect changes).
    """
    from services.pipeline import now_iso
    state = _read(block_dir)
    state["completed"] = True
    state["completed_at"] = now_iso()
    if config_hash:
        state["config_hash"] = config_hash
    state.pop("failed", None)
    state.pop("error", None)
    _write(block_dir, state)


def mark_failed(block_dir, error):
    """Record that a block run failed. The block is not complete."""
    from services.pipeline import now_iso
    state = _read(block_dir)
    state["completed"] = False
    state["failed"] = True
    state["error"] = str(error)
    state["failed_at"] = now_iso()
    _write(block_dir, state)
