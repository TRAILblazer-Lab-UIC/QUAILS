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


def mark_complete(block_dir):
    """Mark a block's analysis as fully completed."""
    path = os.path.join(block_dir, "save_state.json")
    state = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    state["completed"] = True
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
