"""Project CRUD endpoints."""

import os
import json
import uuid
from datetime import datetime
from flask import Blueprint, request, jsonify

from config import PROJECTS_DIR
from services.version_control import init_project_repo, commit_project, remove_project_repo

projects_bp = Blueprint("projects", __name__)


def _project_dir(project_id):
    return os.path.join(PROJECTS_DIR, project_id)


def _load_project(project_id):
    path = os.path.join(_project_dir(project_id), "project.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_project(project_id, data):
    path = os.path.join(_project_dir(project_id), "project.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


@projects_bp.route("/", methods=["GET"])
def list_projects():
    projects = []
    if not os.path.exists(PROJECTS_DIR):
        return jsonify(projects)
    for name in os.listdir(PROJECTS_DIR):
        proj_file = os.path.join(PROJECTS_DIR, name, "project.json")
        if os.path.isfile(proj_file):
            try:
                with open(proj_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if "id" not in data or "created_at" not in data:
                    continue
                projects.append({
                    "id": data["id"],
                    "title": data.get("title", "Untitled"),
                    "created_at": data["created_at"],
                    "updated_at": data.get("updated_at", data["created_at"]),
                    "description": data.get("description", ""),
                })
            except Exception:
                continue
    projects.sort(key=lambda p: p["updated_at"], reverse=True)
    return jsonify(projects)


def _build_flow_template(template):
    """Build a flow.json structure for the given template name."""
    if template != "basic_thematic":
        return {"nodes": [], "edges": []}

    # Basic Thematic Analysis template:
    # ProjectSpec → Open-Coding Analysis → Theme Identification → Category Builder → Outputs & Report
    # Human Review nodes between each analysis block pair (tee edges)
    # Spaced vertically at 250px intervals, centered at x=400
    x = 400
    hr_x = x + 280  # Human review nodes offset to the right

    nodes = [
        {
            "id": "projectSpec_1",
            "type": "projectSpec",
            "position": {"x": x, "y": 50},
            "data": {
                "label": "Project Spec",
                "temperature": 0,
                "seed": 5,
                "top_k": 3,
                "top_p": 0.9,
                "repeat_penalty": 1.0,
            },
        },
        {
            "id": "sourceAnalysis_1",
            "type": "sourceAnalysis",
            "position": {"x": x, "y": 300},
            "data": {"label": "Open-Coding Analysis"},
        },
        {
            "id": "review_1",
            "type": "humanReview",
            "position": {"x": hr_x, "y": 475},
            "data": {
                "label": "Human Review",
                "upstream_block_id": "sourceAnalysis_1",
                "upstream_block_type": "sourceAnalysis",
                "upstream_block_label": "Open-Coding Analysis",
            },
        },
        {
            "id": "themeIdent_1",
            "type": "themeIdent",
            "position": {"x": x, "y": 550},
            "data": {
                "label": "Theme Identification",
                "input_block_ids": ["sourceAnalysis_1"],
            },
        },
        {
            "id": "review_2",
            "type": "humanReview",
            "position": {"x": hr_x, "y": 725},
            "data": {
                "label": "Human Review",
                "upstream_block_id": "themeIdent_1",
                "upstream_block_type": "themeIdent",
                "upstream_block_label": "Theme Identification",
            },
        },
        {
            "id": "categoryBuild_1",
            "type": "categoryBuild",
            "position": {"x": x, "y": 800},
            "data": {"label": "Category Builder"},
        },
        {
            "id": "outputsReport_1",
            "type": "outputsReport",
            "position": {"x": x, "y": 1050},
            "data": {"label": "Outputs & Report"},
        },
    ]

    edges = [
        # ProjectSpec → SourceAnalysis (regular edge)
        {
            "id": "e-projectSpec_1-sourceAnalysis_1",
            "source": "projectSpec_1",
            "target": "sourceAnalysis_1",
            "type": "custom",
        },
        # SourceAnalysis → ThemeIdent (tee edge with human review)
        {
            "id": "e-sourceAnalysis_1-themeIdent_1",
            "source": "sourceAnalysis_1",
            "target": "themeIdent_1",
            "type": "tee",
            "data": {"humanReviewId": "review_1"},
        },
        # ThemeIdent → CategoryBuild (tee edge with human review)
        {
            "id": "e-themeIdent_1-categoryBuild_1",
            "source": "themeIdent_1",
            "target": "categoryBuild_1",
            "type": "tee",
            "data": {"humanReviewId": "review_2"},
        },
        # CategoryBuild → OutputsReport (regular edge)
        {
            "id": "e-categoryBuild_1-outputsReport_1",
            "source": "categoryBuild_1",
            "target": "outputsReport_1",
            "type": "custom",
        },
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "blockOrder": [
            "sourceAnalysis_1",
            "themeIdent_1",
            "categoryBuild_1",
        ],
    }


@projects_bp.route("/", methods=["POST"])
def create_project():
    body = request.get_json()
    title = body.get("title", "Untitled Project")
    description = body.get("description", "")

    project_id = uuid.uuid4().hex[:8]
    now = datetime.utcnow().isoformat() + "Z"

    project_data = {
        "id": project_id,
        "title": title,
        "description": description,
        "created_at": now,
        "updated_at": now,
        "unit_type": "sentence",
        "context_window": 1,
        "llm": {
            "model": body.get("model", "gemma3"),
            "base_url": "http://localhost:11434",
            "temperature": 0.1,
        },
        "thresholds": {
            "detection": 70.0,
            "label": 70.0,
            "theme": 80.0,
        },
        "max_categories": 6,
    }

    proj_dir = _project_dir(project_id)
    os.makedirs(proj_dir, exist_ok=True)
    os.makedirs(os.path.join(proj_dir, "corpus"), exist_ok=True)
    os.makedirs(os.path.join(proj_dir, "parsed"), exist_ok=True)
    os.makedirs(os.path.join(proj_dir, "blocks"), exist_ok=True)
    os.makedirs(os.path.join(proj_dir, "alignment"), exist_ok=True)
    os.makedirs(os.path.join(proj_dir, "reports"), exist_ok=True)

    _save_project(project_id, project_data)

    # Initialize flow — template or blank
    template = body.get("template", "blank")
    flow_data = _build_flow_template(template)
    flow_path = os.path.join(proj_dir, "flow.json")
    with open(flow_path, "w", encoding="utf-8") as f:
        json.dump(flow_data, f, indent=2)

    # Init git repo for this project
    init_project_repo(proj_dir)
    commit_project(proj_dir, "Project created")

    return jsonify(project_data), 201


@projects_bp.route("/<project_id>", methods=["GET"])
def get_project(project_id):
    data = _load_project(project_id)
    if not data:
        return jsonify({"error": "Project not found"}), 404
    return jsonify(data)


@projects_bp.route("/<project_id>", methods=["PUT"])
def update_project(project_id):
    data = _load_project(project_id)
    if not data:
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json()
    for key in ["title", "description", "unit_type", "context_window", "llm", "thresholds", "max_categories", "include_headers", "parallel_analysis_slots"]:
        if key in body:
            data[key] = body[key]

    data["updated_at"] = datetime.utcnow().isoformat() + "Z"
    _save_project(project_id, data)
    commit_project(_project_dir(project_id), "Project settings updated")

    return jsonify(data)


@projects_bp.route("/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    proj_dir = _project_dir(project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404
    remove_project_repo(proj_dir)
    return jsonify({"status": "deleted"})


@projects_bp.route("/<project_id>/save", methods=["POST"])
def save_project(project_id):
    """Manual or autosave trigger."""
    data = _load_project(project_id)
    if not data:
        return jsonify({"error": "Project not found"}), 404
    data["updated_at"] = datetime.utcnow().isoformat() + "Z"
    _save_project(project_id, data)
    commit_project(_project_dir(project_id), "Manual save")
    return jsonify({"status": "saved"})
