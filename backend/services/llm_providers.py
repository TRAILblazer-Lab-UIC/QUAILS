"""Provider registry and API calls for multiple LLM backends."""

import os
import requests
from config import OLLAMA_BASE_URL

PROVIDERS = {
    "ollama": {
        "name": "Ollama (Local)",
        "requires_key": False,
        "env_key": None,
        "env_extra": None,
    },
    "openai": {
        "name": "OpenAI",
        "requires_key": True,
        "env_key": "OPENAI_API_KEY",
        "env_extra": None,
    },
    "anthropic": {
        "name": "Anthropic",
        "requires_key": True,
        "env_key": "ANTHROPIC_API_KEY",
        "env_extra": None,
    },
    "google": {
        "name": "Google Gemini",
        "requires_key": True,
        "env_key": "GOOGLE_API_KEY",
        "env_extra": None,
    },
    "azure": {
        "name": "Azure OpenAI",
        "requires_key": True,
        "env_key": "AZURE_OPENAI_API_KEY",
        "env_extra": "AZURE_OPENAI_ENDPOINT",
    },
}


def mask_key(key):
    """Mask an API key, showing only last 4 characters."""
    if not key or len(key) < 5:
        return "****"
    return "****" + key[-4:]


def list_provider_models(provider_id):
    """List available models for a provider. Returns (models_list, error_or_none)."""
    if provider_id not in PROVIDERS:
        return [], f"Unknown provider: {provider_id}"

    try:
        if provider_id == "ollama":
            return _list_ollama_models()
        elif provider_id == "openai":
            return _list_openai_models()
        elif provider_id == "anthropic":
            return _list_anthropic_models()
        elif provider_id == "google":
            return _list_google_models()
        elif provider_id == "azure":
            return _list_azure_models()
    except requests.ConnectionError:
        return [], f"Connection failed for {PROVIDERS[provider_id]['name']}"
    except requests.Timeout:
        return [], f"Request timed out for {PROVIDERS[provider_id]['name']}"
    except Exception as e:
        return [], str(e)

    return [], "Provider not implemented"


def _list_ollama_models():
    resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=15)
    if resp.status_code != 200:
        return [], f"Ollama returned HTTP {resp.status_code}"
    models = [m["name"] for m in resp.json().get("models", [])]
    return models, None


def _list_openai_models():
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        return [], "No API key configured"
    resp = requests.get(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
        timeout=15,
    )
    if resp.status_code != 200:
        return [], f"OpenAI returned HTTP {resp.status_code}"
    all_models = resp.json().get("data", [])
    filtered = [
        m["id"] for m in all_models
        if any(m["id"].startswith(p) for p in ("gpt-", "o1", "o3", "o4"))
    ]
    filtered.sort()
    return filtered, None


def _list_anthropic_models():
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return [], "No API key configured"
    resp = requests.get(
        "https://api.anthropic.com/v1/models",
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        timeout=15,
    )
    if resp.status_code != 200:
        return [], f"Anthropic returned HTTP {resp.status_code}"
    all_models = resp.json().get("data", [])
    models = sorted([m["id"] for m in all_models])
    return models, None


def _list_google_models():
    key = os.environ.get("GOOGLE_API_KEY", "")
    if not key:
        return [], "No API key configured"
    resp = requests.get(
        f"https://generativelanguage.googleapis.com/v1beta/models?key={key}",
        timeout=15,
    )
    if resp.status_code != 200:
        return [], f"Google returned HTTP {resp.status_code}"
    all_models = resp.json().get("models", [])
    filtered = [
        m["name"].replace("models/", "")
        for m in all_models
        if "gemini" in m.get("name", "").lower()
    ]
    filtered.sort()
    return filtered, None


def _list_azure_models():
    key = os.environ.get("AZURE_OPENAI_API_KEY", "")
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
    if not key or not endpoint:
        return [], "Azure endpoint and API key are both required"
    endpoint = endpoint.rstrip("/")
    resp = requests.get(
        f"{endpoint}/openai/models?api-version=2024-02-01",
        headers={"api-key": key},
        timeout=15,
    )
    if resp.status_code != 200:
        return [], f"Azure returned HTTP {resp.status_code}"
    models = sorted([m["id"] for m in resp.json().get("data", [])])
    return models, None


def check_provider_health(provider_id):
    """Check if a provider is reachable. Returns {connected, error, provider}."""
    if provider_id not in PROVIDERS:
        return {"connected": False, "error": "Unknown provider", "provider": provider_id}

    provider = PROVIDERS[provider_id]

    if provider_id == "ollama":
        try:
            resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
            connected = resp.status_code == 200
            return {"connected": connected, "error": None if connected else f"HTTP {resp.status_code}", "provider": provider_id}
        except (requests.ConnectionError, requests.Timeout):
            return {"connected": False, "error": "Ollama not reachable", "provider": provider_id}

    # For key-based providers, check if key exists and try listing models
    env_key = provider["env_key"]
    key = os.environ.get(env_key, "")
    if not key:
        return {"connected": False, "error": "No API key configured", "provider": provider_id}

    models, error = list_provider_models(provider_id)
    if error:
        return {"connected": False, "error": error, "provider": provider_id}
    return {"connected": True, "error": None, "provider": provider_id}


def get_provider_status():
    """Get status for all providers including masked keys and connection state."""
    result = []
    for pid, pinfo in PROVIDERS.items():
        entry = {
            "id": pid,
            "name": pinfo["name"],
            "requires_key": pinfo["requires_key"],
            "has_key": False,
            "masked_key": None,
            "has_extra": False,
            "masked_extra": None,
            "extra_field": pinfo.get("env_extra"),
        }

        if pinfo["env_key"]:
            key = os.environ.get(pinfo["env_key"], "")
            entry["has_key"] = bool(key)
            entry["masked_key"] = mask_key(key) if key else None

        if pinfo.get("env_extra"):
            extra = os.environ.get(pinfo["env_extra"], "")
            entry["has_extra"] = bool(extra)
            entry["masked_extra"] = mask_key(extra) if extra else None

        health = check_provider_health(pid)
        entry["connected"] = health["connected"]
        entry["error"] = health["error"]

        result.append(entry)

    return result
