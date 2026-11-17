"""llmfit API — hardware scan, model recommendations, and Ollama model pulling."""

from flask import Blueprint, jsonify, request
from extensions import socketio
from services.llmfit_client import check_available, run_scan, pull_model, install_llmfit

llmfit_bp = Blueprint("llmfit", __name__)


@llmfit_bp.route("/status", methods=["GET"])
def status():
    """Check if llmfit is installed, return version and update info."""
    return jsonify(check_available())


@llmfit_bp.route("/scan", methods=["POST"])
def scan():
    """Run llmfit system scan and return scored model recommendations."""
    result = run_scan()
    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)


@llmfit_bp.route("/pull", methods=["POST"])
def pull():
    """Start pulling an Ollama model (progress streamed via SocketIO)."""
    data = request.get_json() or {}
    model = data.get("model")
    if not model:
        return jsonify({"error": "model is required"}), 400

    pull_model(model, socketio)
    return jsonify({"status": "pulling", "model": model})


@llmfit_bp.route("/install", methods=["POST"])
def install():
    """Download and install llmfit binary from GitHub releases."""
    result = install_llmfit(socketio)
    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)
