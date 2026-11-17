"""Report generation and download endpoints."""

import os
from flask import Blueprint, request, jsonify, send_file

from config import PROJECTS_DIR

reports_bp = Blueprint("reports", __name__)


@reports_bp.route("/<project_id>/generate", methods=["POST"])
def generate_report(project_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    from services.report_generator import generate_report
    report_path = generate_report(project_id)

    from services.version_control import commit_project
    commit_project(proj_dir, "Report generated")

    return jsonify({"status": "generated", "path": os.path.basename(report_path)})


@reports_bp.route("/<project_id>/list", methods=["GET"])
def list_reports(project_id):
    reports_dir = os.path.join(PROJECTS_DIR, project_id, "reports")
    if not os.path.exists(reports_dir):
        return jsonify([])
    files = [f for f in os.listdir(reports_dir) if f.endswith(".md")]
    files.sort(reverse=True)
    return jsonify(files)


@reports_bp.route("/<project_id>/download/<filename>", methods=["GET"])
def download_report(project_id, filename):
    reports_dir = os.path.join(PROJECTS_DIR, project_id, "reports")
    filepath = os.path.join(reports_dir, filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "Report not found"}), 404
    return send_file(filepath, as_attachment=True, download_name=filename)


@reports_bp.route("/<project_id>/view/<filename>", methods=["GET"])
def view_report(project_id, filename):
    reports_dir = os.path.join(PROJECTS_DIR, project_id, "reports")
    filepath = os.path.join(reports_dir, filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "Report not found"}), 404
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    return jsonify({"filename": filename, "content": content})
