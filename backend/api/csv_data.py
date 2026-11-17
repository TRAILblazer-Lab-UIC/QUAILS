"""CSV data browsing, editing, flagging, and export endpoints."""

import os
import csv
import json
from flask import Blueprint, request, jsonify, send_file

from config import PROJECTS_DIR

csv_data_bp = Blueprint("csv_data", __name__)


@csv_data_bp.route("/<project_id>/block/<block_id>/<filename>", methods=["GET"])
def get_csv(project_id, block_id, filename):
    """Read a block's CSV file and return as JSON array."""
    csv_path = os.path.join(PROJECTS_DIR, project_id, "blocks", block_id, filename)
    if not os.path.exists(csv_path):
        return jsonify({"error": "CSV file not found"}), 404

    rows = []
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return jsonify({"columns": list(rows[0].keys()) if rows else [], "rows": rows})


@csv_data_bp.route("/<project_id>/block/<block_id>/<filename>/edit", methods=["PUT"])
def edit_csv_row(project_id, block_id, filename):
    """Edit a row in a CSV file."""
    csv_path = os.path.join(PROJECTS_DIR, project_id, "blocks", block_id, filename)
    if not os.path.exists(csv_path):
        return jsonify({"error": "CSV file not found"}), 404

    body = request.get_json()
    row_index = body.get("row_index")
    updates = body.get("updates", {})

    rows = []
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        for row in reader:
            rows.append(row)

    if row_index is None or row_index < 0 or row_index >= len(rows):
        return jsonify({"error": "Invalid row index"}), 400

    rows[row_index].update(updates)

    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    from services.version_control import commit_project
    commit_project(os.path.join(PROJECTS_DIR, project_id), f"CSV edited: {filename}")

    return jsonify({"status": "updated", "row": rows[row_index]})


@csv_data_bp.route("/<project_id>/block/<block_id>/<filename>/export", methods=["GET"])
def export_csv(project_id, block_id, filename):
    """Download a CSV file."""
    csv_path = os.path.join(PROJECTS_DIR, project_id, "blocks", block_id, filename)
    if not os.path.exists(csv_path):
        return jsonify({"error": "CSV file not found"}), 404
    return send_file(csv_path, as_attachment=True, download_name=filename)
