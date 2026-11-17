"""Blueprint: /api/prompts — CRUD for global default and per-project prompt templates."""

from flask import Blueprint, request, jsonify

from services.prompt_template_service import (
    load_global_defaults,
    save_global_defaults,
    load_project_overrides,
    save_project_overrides,
    delete_project_overrides,
    get_effective_templates,
)

bp = Blueprint("prompt_templates", __name__)


@bp.route("/defaults", methods=["GET"])
def get_defaults():
    return jsonify(load_global_defaults())


@bp.route("/defaults", methods=["PUT"])
def put_defaults():
    data = request.get_json(force=True) or {}
    save_global_defaults(data)
    return jsonify({"ok": True})


@bp.route("/<project_id>/overrides", methods=["GET"])
def get_overrides(project_id):
    return jsonify(load_project_overrides(project_id))


@bp.route("/<project_id>/overrides", methods=["PUT"])
def put_overrides(project_id):
    data = request.get_json(force=True) or {}
    save_project_overrides(project_id, data)
    return jsonify({"ok": True})


@bp.route("/<project_id>/overrides", methods=["DELETE"])
def delete_overrides(project_id):
    delete_project_overrides(project_id)
    return jsonify({"ok": True})


@bp.route("/<project_id>/effective", methods=["GET"])
def get_effective(project_id):
    return jsonify(get_effective_templates(project_id))
