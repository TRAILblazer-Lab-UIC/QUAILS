"""Shared pipeline helpers: block failures, expected outputs, block status and
human-review approvals.

A pipeline run (all blocks in flow order) pauses at every Human Review
checkpoint until the researcher approves it. An approval is tied to the exact
completed run of the upstream block (its ``completed_at`` timestamp), so
re-running the upstream block makes the approval out of date.
"""

import os
import json
import hashlib
from datetime import datetime, timezone

from config import PROJECTS_DIR


class BlockFailed(Exception):
    """Raised by a block service when the block cannot produce valid output.

    The engine catches it, marks the block as failed (not complete), reports
    the message to the researcher and stops the run.
    """


# ── Expected output files ─────────────────────────────────────────────────────

def expected_output_files(block_id, block_type, output_format="markdown"):
    """Return the output filenames a completed block must have written."""
    if block_type == "sourceAnalysis":
        return [f"{block_id}_labels.csv", f"{block_id}_false.csv"]
    if block_type == "rubricAnalysis":
        return [f"{block_id}_labels.csv"]
    if block_type == "themeIdent":
        return [f"{block_id}_themes.csv", f"revised{block_id}labels.csv"]
    if block_type == "categoryBuild":
        return ["categoryReport.md"]
    if block_type == "customPrompt":
        ext = "txt" if output_format == "text" else "md"
        return [f"{block_id}_output.{ext}"]
    return []


def missing_outputs(proj_dir, block_id, block_type, block_data):
    block_dir = os.path.join(proj_dir, "blocks", block_id)
    names = expected_output_files(block_id, block_type, (block_data or {}).get("output_format", "markdown"))
    return [n for n in names if not os.path.exists(os.path.join(block_dir, n))]


def clear_block_outputs(proj_dir, block_id, block_type, block_data=None):
    """Delete a block's save state and output files (fresh restart)."""
    from services.save_state import clear_state
    block_dir = os.path.join(proj_dir, "blocks", block_id)
    clear_state(block_dir)
    names = expected_output_files(block_id, block_type, (block_data or {}).get("output_format", "markdown"))
    for name in names:
        path = os.path.join(block_dir, name)
        if os.path.exists(path):
            os.remove(path)


# ── Block configuration and status ───────────────────────────────────────────

_VOLATILE_KEYS = {"status", "reportPath", "label"}


def config_hash(block_data):
    """Stable hash of the settings that affect a block's results."""
    data = {k: v for k, v in (block_data or {}).items()
            if k not in _VOLATILE_KEYS and not str(k).startswith("_")}
    raw = json.dumps(data, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def read_block_state(proj_dir, block_id):
    path = os.path.join(proj_dir, "blocks", block_id, "save_state.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# ── Human review approvals ───────────────────────────────────────────────────

def _reviews_path(project_id):
    return os.path.join(PROJECTS_DIR, project_id, "reviews.json")


def load_reviews(project_id):
    path = _reviews_path(project_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_reviews(project_id, reviews):
    with open(_reviews_path(project_id), "w", encoding="utf-8") as f:
        json.dump(reviews, f, indent=2)


def review_status(project_id, review_id, upstream_block_id):
    """Return the status of one checkpoint.

    waiting  : the upstream block has not completed yet
    pending  : the upstream block completed and awaits review
    approved : approved for the upstream block's current run
    outdated : approved earlier, but the upstream block has been re-run since
    """
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    state = read_block_state(proj_dir, upstream_block_id) if upstream_block_id else {}
    completed_at = state.get("completed_at") if state.get("completed") and not state.get("failed") else None
    rec = load_reviews(project_id).get(review_id)
    if not completed_at:
        status = "waiting"
    elif not rec:
        status = "pending"
    elif rec.get("upstream_completed_at") == completed_at and rec.get("upstream_block_id") == upstream_block_id:
        status = "approved"
    else:
        status = "outdated"
    out = {"review_id": review_id, "upstream_block_id": upstream_block_id, "status": status,
           "upstream_completed_at": completed_at}
    if rec:
        out.update({"approved_at": rec.get("approved_at"), "note": rec.get("note", "")})
    return out


def approve_review(project_id, review_id, upstream_block_id, note=""):
    """Record an approval for the upstream block's current completed run."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    state = read_block_state(proj_dir, upstream_block_id)
    if not state.get("completed") or state.get("failed") or not state.get("completed_at"):
        raise ValueError("The block before this checkpoint has not finished a run yet. Run it first.")
    reviews = load_reviews(project_id)
    reviews[review_id] = {
        "upstream_block_id": upstream_block_id,
        "upstream_completed_at": state["completed_at"],
        "approved_at": now_iso(),
        "note": (note or "").strip(),
    }
    _save_reviews(project_id, reviews)
    from services.version_control import commit_project
    commit_project(proj_dir, f"Human review {review_id} approved (upstream {upstream_block_id})")
    return review_status(project_id, review_id, upstream_block_id)


def revoke_review(project_id, review_id):
    reviews = load_reviews(project_id)
    if review_id in reviews:
        del reviews[review_id]
        _save_reviews(project_id, reviews)
        from services.version_control import commit_project
        commit_project(os.path.join(PROJECTS_DIR, project_id), f"Human review {review_id} approval withdrawn")
