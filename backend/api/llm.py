"""LLM model listing, testing, and status endpoints."""

import requests as http_requests
from flask import Blueprint, request, jsonify

from config import OLLAMA_BASE_URL

llm_bp = Blueprint("llm", __name__)


@llm_bp.route("/status", methods=["GET"])
def ollama_status():
    """Check if Ollama is running."""
    try:
        resp = http_requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        return jsonify({"running": resp.status_code == 200})
    except http_requests.ConnectionError:
        return jsonify({"running": False})


@llm_bp.route("/models", methods=["GET"])
def list_models():
    """List available Ollama models."""
    try:
        resp = http_requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=10)
        if resp.status_code != 200:
            return jsonify({"error": "Ollama not reachable"}), 503
        data = resp.json()
        models = []
        for m in data.get("models", []):
            models.append({
                "name": m.get("name", ""),
                "size": m.get("size", 0),
                "modified_at": m.get("modified_at", ""),
            })
        return jsonify(models)
    except http_requests.ConnectionError:
        return jsonify({"error": "Ollama not running"}), 503


@llm_bp.route("/test", methods=["POST"])
def test_model():
    """Send a test prompt to verify model works."""
    body = request.get_json() or {}
    model = body.get("model", "gemma3")
    prompt = body.get("prompt", "Say hello in one word.")

    try:
        resp = http_requests.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"num_predict": 50},
            },
            timeout=60,
        )
        if resp.status_code != 200:
            return jsonify({"error": f"Model error: {resp.text[:200]}"}), 500
        data = resp.json()
        return jsonify({
            "response": data.get("response", ""),
            "model": model,
            "eval_duration": data.get("eval_duration", 0),
        })
    except http_requests.ConnectionError:
        return jsonify({"error": "Ollama not running"}), 503
    except http_requests.Timeout:
        return jsonify({"error": "Request timed out"}), 504
