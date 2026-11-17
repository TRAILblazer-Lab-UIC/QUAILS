"""Flow graph save/load/validate endpoints."""

import os
import json
from flask import Blueprint, request, jsonify

from config import PROJECTS_DIR
from services.version_control import commit_project

flow_bp = Blueprint("flow", __name__)


@flow_bp.route("/<project_id>", methods=["GET"])
def get_flow(project_id):
    flow_path = os.path.join(PROJECTS_DIR, project_id, "flow.json")
    if not os.path.exists(flow_path):
        return jsonify({"nodes": [], "edges": []})
    with open(flow_path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@flow_bp.route("/<project_id>", methods=["PUT"])
def save_flow(project_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    flow_data = request.get_json()
    flow_path = os.path.join(proj_dir, "flow.json")
    with open(flow_path, "w", encoding="utf-8") as f:
        json.dump(flow_data, f, indent=2)

    commit_project(proj_dir, "Flow updated")
    return jsonify({"status": "saved"})


@flow_bp.route("/<project_id>/validate", methods=["POST"])
def validate_flow(project_id):
    flow_path = os.path.join(PROJECTS_DIR, project_id, "flow.json")
    if not os.path.exists(flow_path):
        return jsonify({"valid": False, "errors": ["No flow defined"]}), 400

    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)

    errors = []
    nodes = flow.get("nodes", [])
    edges = flow.get("edges", [])

    # Check for at least a start and end node
    node_types = [n.get("type", "") for n in nodes]
    if "projectSpec" not in node_types:
        errors.append("Flow must have a Project Spec (start) node")
    if "outputsReport" not in node_types:
        errors.append("Flow must have an Outputs Report (end) node")

    # Check that all edges reference existing nodes
    node_ids = {n["id"] for n in nodes}
    for edge in edges:
        if edge.get("source") not in node_ids:
            errors.append(f"Edge references missing source node: {edge.get('source')}")
        if edge.get("target") not in node_ids:
            errors.append(f"Edge references missing target node: {edge.get('target')}")

    # Check for analysis blocks between start and end
    analysis_types = {"sourceAnalysis", "themeIdent", "categoryBuild", "customPrompt"}
    has_analysis = any(t in analysis_types for t in node_types)
    if not has_analysis:
        errors.append("Flow must have at least one analysis block")

    return jsonify({"valid": len(errors) == 0, "errors": errors})
