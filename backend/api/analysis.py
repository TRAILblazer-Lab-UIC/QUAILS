"""Analysis run, stop, resume, and status endpoints."""

import os
import sys
import json
import subprocess
from flask import Blueprint, request, jsonify

from config import PROJECTS_DIR

analysis_bp = Blueprint("analysis", __name__)

# Track running analyses
_running = {}


@analysis_bp.route("/<project_id>/run", methods=["POST"])
def run_analysis(project_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    if project_id in _running and _running[project_id].get("active"):
        return jsonify({"error": "Analysis already running"}), 409

    body = request.get_json() or {}
    block_id = body.get("block_id")

    from services.analysis_engine import start_analysis
    start_analysis(project_id, block_id)

    return jsonify({"status": "started", "project_id": project_id})


@analysis_bp.route("/<project_id>/stop", methods=["POST"])
def stop_analysis(project_id):
    from services.analysis_engine import stop_analysis
    stop_analysis(project_id)
    return jsonify({"status": "stopping"})


@analysis_bp.route("/<project_id>/resume", methods=["POST"])
def resume_analysis(project_id):
    body = request.get_json() or {}
    block_id = body.get("block_id")

    from services.analysis_engine import resume_analysis
    resume_analysis(project_id, block_id)

    return jsonify({"status": "resuming"})


@analysis_bp.route("/<project_id>/status", methods=["GET"])
def analysis_status(project_id):
    from services.analysis_engine import get_status
    status = get_status(project_id)
    return jsonify(status)


def _get_expected_output_files(block_id, block_type, output_format="markdown", block_data=None):
    """Return list of expected output filenames for a given block."""
    if block_type == "sourceAnalysis":
        return [f"{block_id}_labels.csv", f"{block_id}_false.csv"]
    elif block_type == "rubricAnalysis":
        return [f"{block_id}_labels.csv"]
    elif block_type == "themeIdent":
        return [f"{block_id}_themes.csv", f"revised{block_id}labels.csv"]
    elif block_type == "categoryBuild":
        return ["categoryReport.md"]
    elif block_type == "customPrompt":
        ext = "txt" if output_format == "text" else "md"
        return [f"{block_id}_output.{ext}"]
    return []


@analysis_bp.route("/<project_id>/block-files/<block_id>", methods=["GET"])
def block_files(project_id, block_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow_path = os.path.join(proj_dir, "flow.json")
    if not os.path.exists(flow_path):
        return jsonify({"error": "flow.json not found"}), 404

    with open(flow_path) as f:
        flow = json.load(f)

    node = next((n for n in flow.get("nodes", []) if n["id"] == block_id), None)
    if not node:
        return jsonify({"error": "Block not found"}), 404

    block_type = node.get("type", "")
    block_data = node.get("data", {})
    output_format = block_data.get("output_format", "markdown")
    block_dir = f"blocks/{block_id}"

    filenames = _get_expected_output_files(block_id, block_type, output_format, block_data)
    files = []
    for name in filenames:
        rel = f"{block_dir}/{name}"
        abs_path = os.path.join(proj_dir, rel)
        files.append({
            "name": name,
            "relative_path": rel,
            "exists": os.path.exists(abs_path),
        })

    return jsonify({
        "block_id": block_id,
        "block_type": block_type,
        "block_dir": block_dir,
        "files": files,
        "any_exist": any(f["exists"] for f in files),
    })


@analysis_bp.route("/<project_id>/block-state/<block_id>", methods=["GET"])
def block_state(project_id, block_id):
    """Return save-state and output-file status for a single block."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_dir = os.path.join(proj_dir, "blocks", block_id)

    save_state_path = os.path.join(block_dir, "save_state.json")
    has_save_state = os.path.exists(save_state_path)
    state_data = {}
    if has_save_state:
        with open(save_state_path, "r", encoding="utf-8") as f:
            state_data = json.load(f)

    block_type = ""
    output_format = "markdown"
    flow_path = os.path.join(proj_dir, "flow.json")
    if os.path.exists(flow_path):
        with open(flow_path) as f:
            flow = json.load(f)
        node = next((n for n in flow.get("nodes", []) if n["id"] == block_id), None)
        if node:
            block_type = node.get("type", "")
            output_format = node.get("data", {}).get("output_format", "markdown")

    filenames = _get_expected_output_files(block_id, block_type, output_format)
    output_files = []
    for name in filenames:
        rel = f"blocks/{block_id}/{name}"
        abs_path = os.path.join(proj_dir, rel)
        output_files.append({"name": name, "relative_path": rel, "exists": os.path.exists(abs_path)})

    return jsonify({
        "block_id": block_id,
        "has_save_state": has_save_state,
        "completed_count": state_data.get("completed_count", 0),
        "is_complete": state_data.get("completed", False),
        "output_files": output_files,
        "any_output_exist": any(f["exists"] for f in output_files),
    })


@analysis_bp.route("/<project_id>/block-clear/<block_id>", methods=["POST"])
def block_clear(project_id, block_id):
    """Clear save state and delete output files for a block (fresh restart)."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_dir = os.path.join(proj_dir, "blocks", block_id)

    from services.save_state import clear_state
    clear_state(block_dir)

    flow_path = os.path.join(proj_dir, "flow.json")
    if os.path.exists(flow_path):
        with open(flow_path) as f:
            flow = json.load(f)
        node = next((n for n in flow.get("nodes", []) if n["id"] == block_id), None)
        if node:
            block_type = node.get("type", "")
            output_format = node.get("data", {}).get("output_format", "markdown")
            filenames = _get_expected_output_files(block_id, block_type, output_format)
            for name in filenames:
                abs_path = os.path.join(block_dir, name)
                if os.path.exists(abs_path):
                    os.remove(abs_path)

    return jsonify({"status": "cleared"})


@analysis_bp.route("/<project_id>/open-path", methods=["POST"])
def open_path(project_id):
    body = request.get_json() or {}
    relative_path = body.get("relative_path", "")
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    abs_path = os.path.join(proj_dir, relative_path)

    # Normalize path separators for the current OS
    abs_path = os.path.normpath(abs_path)

    if not abs_path.startswith(os.path.normpath(proj_dir)):
        return jsonify({"error": "Invalid path"}), 400

    if os.path.exists(abs_path):
        target = abs_path
    else:
        target = os.path.dirname(abs_path)
        if not os.path.exists(target):
            return jsonify({"error": "path not found"}), 404

    try:
        if sys.platform == "win32":
            if os.path.isfile(target):
                subprocess.Popen(["explorer", "/select,", target])
            else:
                subprocess.Popen(["explorer", target])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", target])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(target) if os.path.isfile(target) else target])
        return jsonify({"status": "opened"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
