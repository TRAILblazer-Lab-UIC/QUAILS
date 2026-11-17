"""llmfit integration — system hardware scan, model recommendations, and Ollama model pulling."""

import io
import json
import os
import platform
import subprocess
import zipfile

import requests

from config import OLLAMA_BASE_URL

# Directory where llmfit binary is stored within the QUAILS backend
_TOOLS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
_LLMFIT_EXE = "llmfit.exe" if platform.system() == "Windows" else "llmfit"

GITHUB_RELEASES_URL = "https://api.github.com/repos/AlexsJones/llmfit/releases/latest"
GITHUB_HEADERS = {"Accept": "application/vnd.github.v3+json"}


# Maps llmfit model names (HuggingFace-style) → Ollama tags.
# Models not in this dict are excluded from results (not available on Ollama).
LLMFIT_TO_OLLAMA = {
    # Llama family
    "meta-llama/Llama-3.2-1B": "llama3.2:1b",
    "meta-llama/Llama-3.2-1B-Instruct": "llama3.2:1b",
    "meta-llama/Llama-3.2-3B": "llama3.2:3b",
    "meta-llama/Llama-3.2-3B-Instruct": "llama3.2:3b",
    "meta-llama/Llama-3.1-8B": "llama3.1:8b",
    "meta-llama/Llama-3.1-8B-Instruct": "llama3.1:8b",
    "meta-llama/Meta-Llama-3.1-8B": "llama3.1:8b",
    "meta-llama/Meta-Llama-3.1-8B-Instruct": "llama3.1:8b",
    "meta-llama/Llama-3.1-70B": "llama3.1:70b",
    "meta-llama/Llama-3.1-70B-Instruct": "llama3.1:70b",
    "meta-llama/Meta-Llama-3.1-70B": "llama3.1:70b",
    "meta-llama/Meta-Llama-3.1-70B-Instruct": "llama3.1:70b",
    "meta-llama/Llama-3-8B": "llama3:8b",
    "meta-llama/Llama-3-8B-Instruct": "llama3:8b",
    "meta-llama/Meta-Llama-3-8B": "llama3:8b",
    "meta-llama/Meta-Llama-3-8B-Instruct": "llama3:8b",
    "meta-llama/Llama-3-70B": "llama3:70b",
    "meta-llama/Llama-3-70B-Instruct": "llama3:70b",
    "meta-llama/Meta-Llama-3-70B": "llama3:70b",
    "meta-llama/Meta-Llama-3-70B-Instruct": "llama3:70b",
    "meta-llama/Llama-2-7B": "llama2:7b",
    "meta-llama/Llama-2-7B-Chat": "llama2:7b",
    "meta-llama/Llama-2-13B": "llama2:13b",
    "meta-llama/Llama-2-13B-Chat": "llama2:13b",
    "meta-llama/Llama-2-70B": "llama2:70b",
    "meta-llama/Llama-2-70B-Chat": "llama2:70b",
    # Gemma family
    "google/gemma-2-2b": "gemma2:2b",
    "google/gemma-2-2b-it": "gemma2:2b",
    "google/gemma-2-9b": "gemma2:9b",
    "google/gemma-2-9b-it": "gemma2:9b",
    "google/gemma-2-27b": "gemma2:27b",
    "google/gemma-2-27b-it": "gemma2:27b",
    "google/gemma-3-1b-it": "gemma3:1b",
    "google/gemma-3-4b-it": "gemma3:4b",
    "google/gemma-3-12b-it": "gemma3:12b",
    "google/gemma-3-27b-it": "gemma3:27b",
    "google/gemma-7b": "gemma:7b",
    "google/gemma-7b-it": "gemma:7b",
    "google/gemma-2b": "gemma:2b",
    "google/gemma-2b-it": "gemma:2b",
    # Mistral family
    "mistralai/Mistral-7B-v0.1": "mistral:7b",
    "mistralai/Mistral-7B-Instruct-v0.1": "mistral:7b",
    "mistralai/Mistral-7B-Instruct-v0.2": "mistral:7b",
    "mistralai/Mistral-7B-Instruct-v0.3": "mistral:7b",
    "mistralai/Mistral-7B-v0.3": "mistral:7b",
    "mistralai/Mixtral-8x7B-v0.1": "mixtral:8x7b",
    "mistralai/Mixtral-8x7B-Instruct-v0.1": "mixtral:8x7b",
    "mistralai/Mixtral-8x22B-v0.1": "mixtral:8x22b",
    "mistralai/Mixtral-8x22B-Instruct-v0.1": "mixtral:8x22b",
    "mistralai/Mistral-Small-24B-Instruct-2501": "mistral-small:24b",
    "mistralai/Mistral-Nemo-Instruct-2407": "mistral-nemo:12b",
    # Qwen family
    "Qwen/Qwen2.5-0.5B": "qwen2.5:0.5b",
    "Qwen/Qwen2.5-0.5B-Instruct": "qwen2.5:0.5b",
    "Qwen/Qwen2.5-1.5B": "qwen2.5:1.5b",
    "Qwen/Qwen2.5-1.5B-Instruct": "qwen2.5:1.5b",
    "Qwen/Qwen2.5-3B": "qwen2.5:3b",
    "Qwen/Qwen2.5-3B-Instruct": "qwen2.5:3b",
    "Qwen/Qwen2.5-7B": "qwen2.5:7b",
    "Qwen/Qwen2.5-7B-Instruct": "qwen2.5:7b",
    "Qwen/Qwen2.5-14B": "qwen2.5:14b",
    "Qwen/Qwen2.5-14B-Instruct": "qwen2.5:14b",
    "Qwen/Qwen2.5-32B": "qwen2.5:32b",
    "Qwen/Qwen2.5-32B-Instruct": "qwen2.5:32b",
    "Qwen/Qwen2.5-72B": "qwen2.5:72b",
    "Qwen/Qwen2.5-72B-Instruct": "qwen2.5:72b",
    "Qwen/Qwen2-7B": "qwen2:7b",
    "Qwen/Qwen2-7B-Instruct": "qwen2:7b",
    "Qwen/Qwen2-72B": "qwen2:72b",
    "Qwen/Qwen2-72B-Instruct": "qwen2:72b",
    "Qwen/Qwen2.5-Coder-7B-Instruct": "qwen2.5-coder:7b",
    "Qwen/Qwen2.5-Coder-32B-Instruct": "qwen2.5-coder:32b",
    "Qwen/QwQ-32B": "qwq:32b",
    # Phi family
    "microsoft/phi-2": "phi:2.7b",
    "microsoft/Phi-3-mini-4k-instruct": "phi3:3.8b",
    "microsoft/Phi-3-mini-128k-instruct": "phi3:3.8b",
    "microsoft/Phi-3-small-8k-instruct": "phi3:14b",
    "microsoft/Phi-3-medium-4k-instruct": "phi3:14b",
    "microsoft/Phi-3.5-mini-instruct": "phi3.5:3.8b",
    "microsoft/phi-4": "phi4:14b",
    # DeepSeek family
    "deepseek-ai/deepseek-llm-7b-chat": "deepseek-llm:7b",
    "deepseek-ai/deepseek-coder-6.7b-instruct": "deepseek-coder:6.7b",
    "deepseek-ai/deepseek-coder-33b-instruct": "deepseek-coder:33b",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B": "deepseek-r1:1.5b",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": "deepseek-r1:7b",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": "deepseek-r1:14b",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": "deepseek-r1:32b",
    "deepseek-ai/DeepSeek-R1-Distill-Llama-8B": "deepseek-r1:8b",
    "deepseek-ai/DeepSeek-R1-Distill-Llama-70B": "deepseek-r1:70b",
    "deepseek-ai/DeepSeek-V2-Lite-Chat": "deepseek-v2:16b",
    # StarCoder / CodeLlama
    "bigcode/starcoder2-3b": "starcoder2:3b",
    "bigcode/starcoder2-7b": "starcoder2:7b",
    "bigcode/starcoder2-15b": "starcoder2:15b",
    "codellama/CodeLlama-7b-Instruct-hf": "codellama:7b",
    "codellama/CodeLlama-13b-Instruct-hf": "codellama:13b",
    "codellama/CodeLlama-34b-Instruct-hf": "codellama:34b",
    "codellama/CodeLlama-70b-Instruct-hf": "codellama:70b",
    # Vicuna / TinyLlama / Others
    "TinyLlama/TinyLlama-1.1B-Chat-v1.0": "tinyllama:1.1b",
    "lmsys/vicuna-7b-v1.5": "vicuna:7b",
    "lmsys/vicuna-13b-v1.5": "vicuna:13b",
    "NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO": "nous-hermes2:mixtral",
    "teknium/OpenHermes-2.5-Mistral-7B": "openhermes:7b",
    "openchat/openchat-3.5-0106": "openchat:7b",
    "cognitivecomputations/dolphin-2.6-mixtral-8x7b": "dolphin-mixtral:8x7b",
    "upstage/solar-10.7b-instruct-v1.0": "solar:10.7b",
    "stabilityai/stablelm-2-zephyr-1_6b": "stablelm2:1.6b",
    "01-ai/Yi-6B-Chat": "yi:6b",
    "01-ai/Yi-34B-Chat": "yi:34b",
    "internlm/internlm2-chat-7b": "internlm2:7b",
    "internlm/internlm2-chat-20b": "internlm2:20b",
    "THUDM/glm-4-9b-chat": "glm4:9b",
    "allenai/OLMo-7B": "olmo:7b",
    "CohereForAI/aya-23-8B": "aya:8b",
    "CohereForAI/aya-23-35B": "aya:35b",
    "CohereForAI/c4ai-command-r-v01": "command-r:35b",
    "CohereForAI/c4ai-command-r-plus": "command-r-plus:104b",
}


def _get_llmfit_path():
    """Return the path to the llmfit binary — local tools/ dir first, then PATH."""
    local = os.path.join(_TOOLS_DIR, _LLMFIT_EXE)
    if os.path.isfile(local):
        return local
    return "llmfit"  # fall back to PATH


def _get_asset_info():
    """Return (asset_suffix, is_zip) for the current platform and architecture."""
    system = platform.system()
    machine = platform.machine().lower()

    # Normalise architecture
    if machine in ("x86_64", "amd64"):
        arch = "x86_64"
    elif machine in ("aarch64", "arm64"):
        arch = "aarch64"
    else:
        arch = machine

    if system == "Windows":
        return f"{arch}-pc-windows-msvc.zip", True
    elif system == "Darwin":
        return f"{arch}-apple-darwin.tar.gz", False
    else:
        return f"{arch}-unknown-linux-gnu.tar.gz", False


def install_llmfit(socketio=None):
    """Download the latest llmfit release binary into backend/tools/.

    Emits SocketIO events for progress if socketio is provided.
    Returns dict with success/error info.
    """
    def _emit(event, data):
        if socketio:
            socketio.emit(event, data)

    try:
        _emit("llmfit_install_progress", {"status": "Fetching latest release info..."})

        resp = requests.get(GITHUB_RELEASES_URL, timeout=15, headers=GITHUB_HEADERS)
        if resp.status_code != 200:
            return {"error": f"GitHub API returned HTTP {resp.status_code}"}

        release = resp.json()
        tag = release.get("tag_name", "")
        assets = release.get("assets", [])

        suffix, is_zip = _get_asset_info()

        # Find matching asset
        download_url = None
        for asset in assets:
            if asset["name"].endswith(suffix):
                download_url = asset["browser_download_url"]
                break

        if not download_url:
            return {"error": f"No release asset found for this platform ({suffix})"}

        _emit("llmfit_install_progress", {"status": f"Downloading llmfit {tag}..."})

        # Download the archive
        dl_resp = requests.get(download_url, timeout=120, stream=True)
        if dl_resp.status_code != 200:
            return {"error": f"Download failed: HTTP {dl_resp.status_code}"}

        archive_bytes = dl_resp.content

        _emit("llmfit_install_progress", {"status": "Extracting binary..."})

        # Ensure tools directory exists
        os.makedirs(_TOOLS_DIR, exist_ok=True)

        dest = os.path.join(_TOOLS_DIR, _LLMFIT_EXE)

        if is_zip:
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as zf:
                # Find the llmfit binary inside the zip
                exe_name = None
                for name in zf.namelist():
                    basename = os.path.basename(name)
                    if basename == _LLMFIT_EXE:
                        exe_name = name
                        break
                if not exe_name:
                    return {"error": f"Could not find {_LLMFIT_EXE} inside the archive"}
                with zf.open(exe_name) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
        else:
            import tarfile
            with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
                exe_name = None
                for member in tf.getmembers():
                    basename = os.path.basename(member.name)
                    if basename == _LLMFIT_EXE:
                        exe_name = member.name
                        break
                if not exe_name:
                    return {"error": f"Could not find {_LLMFIT_EXE} inside the archive"}
                f = tf.extractfile(exe_name)
                if f is None:
                    return {"error": f"Could not extract {_LLMFIT_EXE} from archive"}
                with open(dest, "wb") as dst:
                    dst.write(f.read())

        # Make executable on Unix
        if platform.system() != "Windows":
            os.chmod(dest, 0o755)

        # Verify it runs
        try:
            proc = subprocess.run([dest, "--version"], capture_output=True, text=True, timeout=10)
            version = (proc.stdout.strip() or proc.stderr.strip()) if proc.returncode == 0 else "unknown"
        except Exception:
            version = "unknown"

        _emit("llmfit_install_progress", {"status": "Done"})
        return {"installed": True, "version": version, "path": dest}

    except Exception as e:
        return {"error": str(e)}


def check_available():
    """Check if llmfit is installed and if an update is available."""
    result = {
        "installed": False,
        "version": None,
        "update_available": False,
        "latest_version": None,
    }

    llmfit = _get_llmfit_path()

    try:
        proc = subprocess.run(
            [llmfit, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if proc.returncode == 0:
            result["installed"] = True
            result["version"] = proc.stdout.strip() or proc.stderr.strip()
    except FileNotFoundError:
        return result
    except Exception:
        return result

    # Check for updates (best-effort, never fail)
    try:
        resp = requests.get(GITHUB_RELEASES_URL, timeout=5, headers=GITHUB_HEADERS)
        if resp.status_code == 200:
            latest = resp.json().get("tag_name", "")
            result["latest_version"] = latest
            current = result["version"] or ""
            # Strip leading 'v' for comparison
            current_clean = current.lstrip("vV").split()[0] if current else ""
            latest_clean = latest.lstrip("vV") if latest else ""
            if latest_clean and current_clean and latest_clean != current_clean:
                result["update_available"] = True
    except Exception:
        pass

    return result


def run_scan():
    """Run llmfit --json and return hardware info + scored model list."""
    llmfit = _get_llmfit_path()

    try:
        proc = subprocess.run(
            [llmfit, "--json"],
            capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        return {"error": "llmfit is not installed"}
    except subprocess.TimeoutExpired:
        return {"error": "llmfit scan timed out (120s)"}

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        return {"error": f"llmfit exited with code {proc.returncode}: {stderr}"}

    # Parse JSON output — be defensive
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"error": "Failed to parse llmfit JSON output"}

    # Extract system info (adapt to actual llmfit schema)
    system_info = data.get("system") or data.get("hardware") or data.get("system_info") or {}

    # Extract model list (adapt to actual llmfit schema)
    raw_models = data.get("models") or data.get("recommendations") or data.get("results") or []
    if isinstance(data, list):
        # Some versions may output a flat list of models
        raw_models = data

    # Get currently installed Ollama models
    installed_ollama = set()
    try:
        resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        if resp.status_code == 200:
            for m in resp.json().get("models", []):
                name = m.get("name", "")
                installed_ollama.add(name)
                # Also add without :latest suffix
                if name.endswith(":latest"):
                    installed_ollama.add(name.replace(":latest", ""))
    except Exception:
        pass

    # Map and filter models
    models = []
    for m in raw_models:
        model_name = m.get("name") or m.get("model") or m.get("id") or ""
        ollama_name = LLMFIT_TO_OLLAMA.get(model_name)
        if not ollama_name:
            continue

        # Extract scores — llmfit uses score_components dict + top-level score
        sc = m.get("score_components") or m.get("scores") or {}
        quality = sc.get("quality", 0)
        speed = sc.get("speed", 0)
        fit = sc.get("fit", 0)
        context = sc.get("context", 0)
        composite = m.get("score") or sc.get("composite", 0)

        if not composite and any([quality, speed, fit, context]):
            vals = [v for v in [quality, speed, fit, context] if v]
            composite = sum(vals) / len(vals) if vals else 0

        def normalize(v):
            if isinstance(v, (int, float)) and 0 < v <= 1:
                return round(v * 100, 1)
            return round(v, 1) if isinstance(v, (int, float)) else 0

        quality = normalize(quality)
        speed = normalize(speed)
        fit = normalize(fit)
        context = normalize(context)
        composite = normalize(composite)

        # Check if already installed in Ollama
        already_installed = (
            ollama_name in installed_ollama
            or f"{ollama_name}:latest" in installed_ollama
        )

        models.append({
            "name": model_name,
            "ollama_name": ollama_name,
            "ollama_available": True,
            "already_installed": already_installed,
            "size_gb": m.get("memory_required_gb") or m.get("total_memory_gb") or m.get("size_gb") or None,
            "parameters": m.get("parameter_count") or m.get("parameters") or None,
            "context_window": m.get("context_length") or m.get("context_window") or None,
            "category": m.get("category") or None,
            "use_case": m.get("use_case") or None,
            "best_quant": m.get("best_quant") or None,
            "estimated_tps": m.get("estimated_tps") or None,
            "provider": m.get("provider") or None,
            "release_date": m.get("release_date") or None,
            "fit_level": m.get("fit_level") or None,
            "run_mode": m.get("run_mode") or None,
            "runtime_label": m.get("runtime_label") or None,
            "total_memory_gb": m.get("total_memory_gb") or None,
            "utilization_pct": m.get("utilization_pct") or None,
            "is_moe": m.get("is_moe") or False,
            "notes": m.get("notes") or [],
            "scores": {
                "quality": quality,
                "speed": speed,
                "fit": fit,
                "context": context,
                "composite": composite,
            },
        })

    # Sort by weighted score: fit and speed weighted higher than quality and context
    def _sort_key(x):
        s = x["scores"]
        return s["fit"] * 0.35 + s["speed"] * 0.35 + s["quality"] * 0.20 + s["context"] * 0.10
    models.sort(key=_sort_key, reverse=True)

    # Deduplicate by ollama_name (keep highest composite)
    seen = set()
    unique_models = []
    for m in models:
        if m["ollama_name"] not in seen:
            seen.add(m["ollama_name"])
            unique_models.append(m)

    return {
        "system": system_info,
        "models": unique_models,
        "total_models": len(unique_models),
    }


def pull_model(model_name, socketio):
    """Pull an Ollama model in a background thread with SocketIO progress."""

    def _pull():
        try:
            resp = requests.post(
                f"{OLLAMA_BASE_URL}/api/pull",
                json={"name": model_name, "stream": True},
                stream=True,
                timeout=3600,
            )

            if resp.status_code != 200:
                socketio.emit("model_pull_error", {
                    "model": model_name,
                    "error": f"Ollama returned HTTP {resp.status_code}",
                })
                return

            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue

                status = chunk.get("status", "")
                total = chunk.get("total", 0)
                completed = chunk.get("completed", 0)
                pct = round((completed / total) * 100, 1) if total else 0

                socketio.emit("model_pull_progress", {
                    "model": model_name,
                    "status": status,
                    "pct": pct,
                    "completed": completed,
                    "total": total,
                })

            socketio.emit("model_pull_complete", {"model": model_name})

        except Exception as e:
            socketio.emit("model_pull_error", {
                "model": model_name,
                "error": str(e),
            })

    socketio.start_background_task(_pull)
