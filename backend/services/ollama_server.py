"""Read and apply Ollama *server* settings (environment variables read at `ollama serve` start).

How Ollama runs decides what QUAILS may do:
  - macOS Ollama.app      → `launchctl setenv` + restart the app (no sudo needed)
  - `ollama serve` that QUAILS started → restart it with the new environment
  - Linux systemd service → QUAILS only *shows* the override + restart commands (needs sudo)
  - Windows               → QUAILS only shows `setx` commands
QUAILS never runs sudo. Settings it applied are persisted in backend/.env as OLLAMA_SERVER_*.
"""

import os
import platform
import shutil
import subprocess
import time

import requests

from config import ENV_PATH, OLLAMA_BASE_URL

SERVER_VARS = ("OLLAMA_NUM_PARALLEL", "OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_MAX_LOADED_MODELS")
PREFIX = "OLLAMA_SERVER_"
_child = None  # Popen of an `ollama serve` QUAILS started


def _run(cmd, timeout=10):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.returncode, out.stdout.strip(), out.stderr.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, "", str(e)


def _up(base_url=OLLAMA_BASE_URL):
    try:
        return requests.get(f"{base_url}/api/tags", timeout=3).status_code == 200
    except Exception:
        return False


def _wait_up(timeout=30):
    for _ in range(timeout):
        if _up():
            return True
        time.sleep(1)
    return False


def mode():
    system = platform.system()
    if system == "Darwin":
        if os.path.isdir("/Applications/Ollama.app") or os.path.isdir(os.path.expanduser("~/Applications/Ollama.app")):
            return "mac_app"
        return "managed" if shutil.which("ollama") else "unknown"
    if system == "Linux":
        if shutil.which("systemctl"):
            rc, out, _ = _run(["systemctl", "is-active", "ollama"])
            if out == "active":
                return "systemd"
        return "managed" if shutil.which("ollama") else "unknown"
    if system == "Windows":
        return "windows"
    return "unknown"


def saved_settings():
    """Settings QUAILS last applied (backend/.env OLLAMA_SERVER_*)."""
    return {v: os.environ.get(PREFIX + v) for v in SERVER_VARS if os.environ.get(PREFIX + v)}


def server_env():
    """Environment for an `ollama serve` that QUAILS (or its launcher) starts."""
    env = dict(os.environ)
    env.update(saved_settings())
    return env


def current_settings():
    m = mode()
    live = {}
    if m == "mac_app":
        for v in SERVER_VARS:
            rc, out, _ = _run(["launchctl", "getenv", v])
            if out:
                live[v] = out
    elif m == "systemd":
        rc, out, _ = _run(["systemctl", "show", "ollama", "-p", "Environment"])
        for tok in out.replace("Environment=", "").split():
            if "=" in tok:
                k, val = tok.split("=", 1)
                if k in SERVER_VARS:
                    live[k] = val
    elif m == "managed" and _child is not None:
        live = saved_settings()
    return {"mode": m, "live": live, "saved": saved_settings(), "running": _up(),
            "known": m in ("mac_app", "systemd") or (m == "managed" and _child is not None)}


def _persist(settings):
    from dotenv import set_key
    if not os.path.exists(ENV_PATH):
        open(ENV_PATH, "a").close()
    for k, v in settings.items():
        set_key(ENV_PATH, PREFIX + k, str(v))
        os.environ[PREFIX + k] = str(v)


def instructions(settings):
    m = mode()
    if m == "systemd":
        body = "\n".join(f'Environment="{k}={v}"' for k, v in settings.items())
        return {"mode": m, "steps": [
            "Run: sudo systemctl edit ollama",
            "Paste between the comment lines:\n[Service]\n" + body,
            "Then: sudo systemctl daemon-reload && sudo systemctl restart ollama",
        ]}
    if m == "windows":
        return {"mode": m, "steps": [f"setx {k} {v}" for k, v in settings.items()] +
                ["Quit Ollama from the system tray and start it again."]}
    return {"mode": m, "steps": []}


def apply(settings):
    """Apply server settings. Returns {applied: bool, ...}."""
    global _child
    settings = {k: str(v) for k, v in (settings or {}).items() if k in SERVER_VARS and v not in (None, "")}
    if not settings:
        return {"error": "No settings to apply."}
    busy = _busy_reason()
    if busy:
        return {"error": busy}
    m = mode()
    if m in ("systemd", "windows", "unknown"):
        _persist(settings)
        return {"applied": False, "mode": m, "instructions": instructions(settings),
                "message": "QUAILS cannot restart this Ollama installation itself; run the steps below."}

    if m == "mac_app":
        for k, v in settings.items():
            rc, _, err = _run(["launchctl", "setenv", k, v])
            if rc != 0:
                return {"error": f"launchctl setenv {k} failed: {err}"}
        _run(["osascript", "-e", 'quit app "Ollama"'])
        for _ in range(15):
            if not _up():
                break
            time.sleep(1)
        _run(["pkill", "-f", "ollama serve"])  # the app's server can outlive the menu-bar app briefly
        time.sleep(1)
        _run(["open", "-a", "Ollama"])
        _persist(settings)
        ok = _wait_up(45)
        return {"applied": ok, "mode": m,
                "message": "Ollama restarted with the new settings." if ok else "Settings saved, but Ollama did not come back within 45 s — start Ollama manually."}

    # managed: restart an `ollama serve` with the new environment
    _persist(settings)
    if _child is not None and _child.poll() is None:
        _child.terminate()
        try:
            _child.wait(10)
        except subprocess.TimeoutExpired:
            _child.kill()
    else:
        _run(["pkill", "-f", "ollama serve"])
        time.sleep(1)
    _child = subprocess.Popen(["ollama", "serve"], env=server_env(),
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = _wait_up(30)
    return {"applied": ok, "mode": m,
            "message": "Ollama restarted with the new settings." if ok else "Ollama did not come back within 30 s."}


def _busy_reason():
    from services import analysis_engine, optimization_job
    for pid, st in list(analysis_engine._running_analyses.items()):
        if st.get("active"):
            return "An analysis is running; wait for it to finish before restarting Ollama."
    if any(optimization_job._running.values()):
        return "An optimization job is running; stop it before restarting Ollama."
    from services import alignment_runner
    if getattr(alignment_runner, "_active_runs", None):
        return "An alignment comparison is running; wait for it to finish."
    return None


def benchmark(model, base_url=OLLAMA_BASE_URL):
    """One short generation; reports load time and token throughput from Ollama's own timings."""
    from services.ollama_client import OllamaClient
    c = OllamaClient(base_url=base_url, model=model)
    prompt = ("Summarize in two sentences why qualitative researchers check inter-rater reliability. " * 8).strip()
    t0 = time.time()
    res = c.chat([{"role": "user", "content": prompt}], num_predict=128, logprobs=False)
    if res.get("error"):
        return {"error": res["error"]}
    raw = res.get("raw") or {}
    ns = 1e9
    pe, pd = raw.get("prompt_eval_count") or 0, raw.get("prompt_eval_duration") or 0
    ec, ed = raw.get("eval_count") or 0, raw.get("eval_duration") or 0
    from services.hardware_profile import gpu_residency
    return {
        "model": model,
        "wall_sec": round(time.time() - t0, 2),
        "load_sec": round((raw.get("load_duration") or 0) / ns, 2),
        "prompt_tokens": pe, "prompt_tokens_per_sec": round(pe / (pd / ns), 1) if pd else None,
        "gen_tokens": ec, "gen_tokens_per_sec": round(ec / (ed / ns), 1) if ed else None,
        "residency": gpu_residency(base_url),
    }
