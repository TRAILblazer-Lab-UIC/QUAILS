"""Settings blueprint for LLM provider management."""

import os
from flask import Blueprint, jsonify, request
from dotenv import set_key, unset_key

from config import APP_VERSION, CRASH_REPORT_FORM_URL, SUGGESTION_FORM_URL, ENV_PATH
from services.llm_providers import (
    PROVIDERS,
    mask_key,
    list_provider_models,
    check_provider_health,
    get_provider_status,
)

settings_bp = Blueprint("settings", __name__)


def _ensure_env_file():
    """Create .env file if it doesn't exist."""
    if not os.path.exists(ENV_PATH):
        with open(ENV_PATH, "w") as f:
            f.write("")


@settings_bp.route("/providers", methods=["GET"])
def get_providers():
    """Get all providers with status, masked keys, and active selection."""
    providers = get_provider_status()
    active_provider = os.environ.get("SELECTED_PROVIDER", "ollama")
    active_model = os.environ.get("SELECTED_MODEL", "gemma3")
    return jsonify({
        "providers": providers,
        "active_provider": active_provider,
        "active_model": active_model,
    })


@settings_bp.route("/providers/<provider_id>/key", methods=["PUT"])
def save_provider_key(provider_id):
    """Save API key (and extra fields) for a provider."""
    if provider_id not in PROVIDERS:
        return jsonify({"error": "Unknown provider"}), 404

    provider = PROVIDERS[provider_id]
    if not provider["requires_key"]:
        return jsonify({"error": "This provider does not use an API key"}), 400

    data = request.get_json()
    if not data or not data.get("key"):
        return jsonify({"error": "API key is required"}), 400

    _ensure_env_file()

    # Save API key
    env_key_name = provider["env_key"]
    api_key = data["key"]
    set_key(ENV_PATH, env_key_name, api_key)
    os.environ[env_key_name] = api_key

    # Save extra field (e.g. Azure endpoint)
    masked_extra = None
    if provider.get("env_extra"):
        extra_value = data.get("extra", "")
        if extra_value:
            set_key(ENV_PATH, provider["env_extra"], extra_value)
            os.environ[provider["env_extra"]] = extra_value
            masked_extra = mask_key(extra_value)

    # Check health after saving
    health = check_provider_health(provider_id)

    return jsonify({
        "masked_key": mask_key(api_key),
        "masked_extra": masked_extra,
        "connected": health["connected"],
        "error": health["error"],
    })


@settings_bp.route("/providers/<provider_id>/key", methods=["DELETE"])
def delete_provider_key(provider_id):
    """Remove API key for a provider. Resets to Ollama if was active."""
    if provider_id not in PROVIDERS:
        return jsonify({"error": "Unknown provider"}), 404

    provider = PROVIDERS[provider_id]
    if not provider["requires_key"]:
        return jsonify({"error": "This provider does not use an API key"}), 400

    _ensure_env_file()

    # Remove API key
    env_key_name = provider["env_key"]
    unset_key(ENV_PATH, env_key_name)
    os.environ.pop(env_key_name, None)

    # Remove extra field
    if provider.get("env_extra"):
        unset_key(ENV_PATH, provider["env_extra"])
        os.environ.pop(provider["env_extra"], None)

    # If this was the active provider, reset to Ollama
    active = os.environ.get("SELECTED_PROVIDER", "ollama")
    if active == provider_id:
        set_key(ENV_PATH, "SELECTED_PROVIDER", "ollama")
        set_key(ENV_PATH, "SELECTED_MODEL", "gemma3")
        os.environ["SELECTED_PROVIDER"] = "ollama"
        os.environ["SELECTED_MODEL"] = "gemma3"

    return jsonify({"ok": True})


@settings_bp.route("/providers/<provider_id>/models", methods=["GET"])
def get_models(provider_id):
    """List available models for a connected provider."""
    if provider_id not in PROVIDERS:
        return jsonify({"error": "Unknown provider"}), 404

    models, error = list_provider_models(provider_id)
    if error:
        return jsonify({"models": [], "error": error})
    return jsonify({"models": models, "error": None})


@settings_bp.route("/active-model", methods=["PUT"])
def set_active_model():
    """Set the selected provider and model."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Request body required"}), 400

    provider_id = data.get("provider")
    model = data.get("model")

    if not provider_id or not model:
        return jsonify({"error": "provider and model are required"}), 400

    if provider_id not in PROVIDERS:
        return jsonify({"error": "Unknown provider"}), 404

    _ensure_env_file()

    set_key(ENV_PATH, "SELECTED_PROVIDER", provider_id)
    set_key(ENV_PATH, "SELECTED_MODEL", model)
    os.environ["SELECTED_PROVIDER"] = provider_id
    os.environ["SELECTED_MODEL"] = model

    return jsonify({
        "active_provider": provider_id,
        "active_model": model,
    })


@settings_bp.route("/ollama-context", methods=["GET"])
def get_ollama_context():
    """Get the current Ollama context window override."""
    raw = os.environ.get("OLLAMA_NUM_CTX", "")
    num_ctx = int(raw) if raw.isdigit() and int(raw) > 0 else None
    return jsonify({
        "default": 2048,
        "current": num_ctx,
    })


@settings_bp.route("/ollama-context", methods=["PUT"])
def set_ollama_context():
    """Set the Ollama context window override. Send null/0 to reset to default."""
    data = request.get_json() or {}
    value = data.get("num_ctx")

    _ensure_env_file()

    if value and int(value) > 0:
        num_ctx = int(value)
        set_key(ENV_PATH, "OLLAMA_NUM_CTX", str(num_ctx))
        os.environ["OLLAMA_NUM_CTX"] = str(num_ctx)
        return jsonify({"current": num_ctx})
    else:
        unset_key(ENV_PATH, "OLLAMA_NUM_CTX")
        os.environ.pop("OLLAMA_NUM_CTX", None)
        return jsonify({"current": None})


@settings_bp.route("/feedback-config", methods=["GET"])
def get_feedback_config():
    """Return Formspree form URLs and app version for crash/suggestion submissions."""
    return jsonify({
        "crash_report_url": CRASH_REPORT_FORM_URL or None,
        "suggestion_url": SUGGESTION_FORM_URL or None,
        "app_version": APP_VERSION,
    })


@settings_bp.route("/health", methods=["GET"])
def health_check():
    """Health check for the currently selected provider."""
    provider_id = os.environ.get("SELECTED_PROVIDER", "ollama")
    model = os.environ.get("SELECTED_MODEL", "gemma3")
    health = check_provider_health(provider_id)
    return jsonify({
        "provider": provider_id,
        "model": model,
        "connected": health["connected"],
        "error": health["error"],
    })


# ── Hardware & performance (unified-memory aware) ──────────────────────────

@settings_bp.route("/hardware", methods=["GET"])
def get_hardware():
    """Detected accelerator + GPU-addressable memory budget + live GPU residency."""
    from services.hardware_profile import detect, gpu_residency
    profile = detect(refresh=request.args.get("refresh") == "1")
    return jsonify({"profile": profile, "residency": gpu_residency()})


@settings_bp.route("/hardware/fit", methods=["GET"])
def get_hardware_fit():
    """Fit estimate for every installed Ollama model, plus recommended server settings."""
    from services.hardware_profile import detect
    from services import model_fit
    profile = detect()
    num_ctx = int(request.args.get("num_ctx") or model_fit.current_num_ctx())
    active = request.args.get("model") or os.environ.get("SELECTED_MODEL", "gemma3")
    models = [model_fit.estimate(name, size, profile.get("gpu_budget_gb"), num_ctx)
              for name, size in model_fit.installed_models()]
    return jsonify({
        "num_ctx": num_ctx,
        "budget_gb": profile.get("gpu_budget_gb"),
        "models": models,
        "recommendation": model_fit.recommend(profile, active, num_ctx),
    })


@settings_bp.route("/ollama-server", methods=["GET"])
def get_ollama_server():
    from services.ollama_server import current_settings
    return jsonify(current_settings())


@settings_bp.route("/ollama-server/apply", methods=["POST"])
def apply_ollama_server():
    from services.ollama_server import apply
    result = apply((request.get_json() or {}).get("settings") or {})
    return (jsonify(result), 409) if "error" in result else jsonify(result)


@settings_bp.route("/benchmark", methods=["POST"])
def run_benchmark():
    from services.ollama_server import benchmark
    model = (request.get_json() or {}).get("model") or os.environ.get("SELECTED_MODEL", "gemma3")
    result = benchmark(model)
    return (jsonify(result), 502) if "error" in result else jsonify(result)
