"""Will a model + its context fit in GPU-addressable memory? And what Ollama
server settings suit this machine?

Estimates are deliberately conservative and labelled as estimates; Ollama's
/api/ps residency is the ground truth once a model is loaded.
"""

import math
import os

import requests

from config import OLLAMA_BASE_URL

GB = 1024 ** 3
OVERHEAD_GB = 0.6               # compute graph / runtime buffers (rough)
KV_BYTES = {"f16": 2.0, "q8_0": 1.0625, "q4_0": 0.5625}
FIT_OK, FIT_TIGHT = 0.85, 1.0

_show_cache = {}


def _show(model, base_url=OLLAMA_BASE_URL):
    if model in _show_cache:
        return _show_cache[model]
    try:
        r = requests.post(f"{base_url}/api/show", json={"model": model}, timeout=10)
        data = r.json() if r.status_code == 200 else {}
    except Exception:
        data = {}
    _show_cache[model] = data
    return data


def kv_geometry(model_info):
    """Per-token KV geometry from /api/show model_info (architecture-prefixed keys)."""
    arch = model_info.get("general.architecture") or next(
        (k.split(".")[0] for k in model_info if k.endswith(".block_count")), None)
    if not arch:
        return None
    g = lambda key: model_info.get(f"{arch}.{key}")
    layers = g("block_count")
    heads = g("attention.head_count")
    kv_heads = g("attention.head_count_kv") or heads
    if isinstance(kv_heads, list):            # some models vary per layer
        kv_heads = max(kv_heads)
    if isinstance(heads, list):
        heads = max(heads)
    emb = g("embedding_length")
    k_len = g("attention.key_length") or (emb // heads if emb and heads else None)
    v_len = g("attention.value_length") or k_len
    if not (layers and kv_heads and k_len):
        return None
    window = g("attention.sliding_window")
    swa_layers = 0
    if window and arch.startswith("gemma"):
        swa_layers = layers - math.ceil(layers / 6)   # gemma3: 5 local : 1 global
    return {"arch": arch, "layers": layers, "kv_heads": kv_heads, "k_len": k_len, "v_len": v_len,
            "sliding_window": window, "swa_layers": swa_layers,
            "max_context": g("context_length")}


def kv_cache_gb(geom, num_ctx, num_parallel=1, kv_type="f16"):
    if not geom:
        return None
    per_layer_token = geom["kv_heads"] * (geom["k_len"] + geom["v_len"]) * KV_BYTES.get(kv_type, 2.0)
    full_layers = geom["layers"] - geom["swa_layers"]
    swa_ctx = min(num_ctx, geom["sliding_window"] or num_ctx)
    total = per_layer_token * (full_layers * num_ctx + geom["swa_layers"] * swa_ctx) * num_parallel
    return total / GB


def fit_status(needed_gb, budget_gb):
    if budget_gb is None:
        return "cpu"
    if needed_gb is None:
        return "unknown"
    r = needed_gb / budget_gb
    return "fits" if r <= FIT_OK else "tight" if r <= FIT_TIGHT else "spills"


def estimate(model, size_bytes, budget_gb, num_ctx, num_parallel=1, kv_type="f16", base_url=OLLAMA_BASE_URL):
    info = _show(model, base_url)
    geom = kv_geometry(info.get("model_info") or {})
    weights = (size_bytes or 0) / GB
    kv = kv_cache_gb(geom, num_ctx, num_parallel, kv_type)
    needed = weights + (kv or 0) + OVERHEAD_GB if kv is not None else None
    return {
        "model": model,
        "weights_gb": round(weights, 2),
        "kv_cache_gb": round(kv, 2) if kv is not None else None,
        "total_gb": round(needed, 2) if needed is not None else round(weights + OVERHEAD_GB, 2),
        "status": fit_status(needed if needed is not None else weights + OVERHEAD_GB, budget_gb),
        "kv_estimated": kv is not None,
        "num_ctx": num_ctx, "num_parallel": num_parallel, "kv_type": kv_type,
        "max_context": (geom or {}).get("max_context"),
        "details": info.get("details") or {},
    }


def installed_models(base_url=OLLAMA_BASE_URL):
    try:
        r = requests.get(f"{base_url}/api/tags", timeout=5)
        return [(m["name"], m.get("size") or 0) for m in r.json().get("models", [])] if r.status_code == 200 else []
    except Exception:
        return []


def current_num_ctx():
    try:
        v = int(os.environ.get("OLLAMA_NUM_CTX", "") or 0)
        return v if v > 0 else 2048
    except ValueError:
        return 2048


def recommend(profile, active_model, num_ctx, base_url=OLLAMA_BASE_URL):
    """Two server profiles: 'reproducible' (one request at a time) and 'throughput'.

    KV cache stays f16 whenever it fits (fidelity first); q8_0 only when needed.
    """
    budget = profile.get("gpu_budget_gb")
    gpu = profile.get("kind") != "cpu"
    sizes = dict(installed_models(base_url))
    size = sizes.get(active_model) or sizes.get(f"{active_model}:latest")
    reasons = []

    def best_kv(parallel):
        for kv in ("f16", "q8_0"):
            if kv == "q8_0" and not gpu:
                break
            e = estimate(active_model, size, budget, num_ctx, parallel, kv, base_url) if size else None
            if e and e["status"] in ("fits", "cpu", "unknown"):
                return kv, e
        return None, (estimate(active_model, size, budget, num_ctx, parallel, "q8_0" if gpu else "f16", base_url) if size else None)

    repro_kv, repro_est = best_kv(1)
    reproducible = {
        "OLLAMA_NUM_PARALLEL": "1",
        "OLLAMA_FLASH_ATTENTION": "1" if gpu else "0",
        "OLLAMA_KV_CACHE_TYPE": repro_kv or ("q8_0" if gpu else "f16"),
    }
    if gpu:
        reasons.append("Flash attention lowers memory use for long contexts and is required for a quantized KV cache.")
    reasons.append("One request slot: Ollama otherwise may reserve context for up to 4 parallel requests, "
                   "multiplying KV-cache memory, while QUAILS analyses run one request at a time.")
    if repro_kv == "f16":
        reasons.append("KV cache kept at full precision (f16) because it fits — best fidelity.")
    elif repro_kv == "q8_0":
        reasons.append("KV cache quantized to q8_0 so this context fits in GPU memory (small fidelity cost).")
    else:
        reasons.append("Even with a q8_0 KV cache this model + context will not fully fit; lower the context window or use a smaller model.")

    throughput, thr_est = None, None
    if gpu and budget:
        for p in (4, 2):
            kv, est = best_kv(p)
            if kv:
                throughput = dict(reproducible, OLLAMA_NUM_PARALLEL=str(p), OLLAMA_KV_CACHE_TYPE=kv)
                thr_est = est
                break

    advisories = []
    if profile.get("kind") == "apple_unified" and repro_est and repro_est["status"] == "spills" and profile.get("total_ram_gb"):
        need_mb = int(math.ceil(repro_est["total_gb"] * 1.1 * 1024))
        if need_mb < profile["total_ram_gb"] * 0.9 * 1024:
            advisories.append({
                "kind": "mac_wired_limit",
                "message": f"{active_model} needs ≈{repro_est['total_gb']:.1f} GB but macOS lets the GPU use ≈{budget:.1f} GB by default. "
                           "You can raise the GPU memory limit until the next reboot (leave headroom for other apps):",
                "command": f"sudo sysctl iogpu.wired_limit_mb={need_mb}",
            })
    return {
        "active_model": active_model, "num_ctx": num_ctx,
        "reproducible": {"settings": reproducible, "estimate": repro_est},
        "throughput": {"settings": throughput, "estimate": thr_est} if throughput else None,
        "reasons": reasons, "advisories": advisories,
        "note": "Server settings change floating-point arithmetic. Settle them before a study's coding begins and keep them fixed; they are recorded with every run.",
    }


def _selftest():
    ok = 0
    gemma = {"general.architecture": "gemma3", "gemma3.block_count": 34, "gemma3.attention.head_count": 8,
             "gemma3.attention.head_count_kv": 4, "gemma3.attention.key_length": 256,
             "gemma3.attention.value_length": 256, "gemma3.attention.sliding_window": 1024,
             "gemma3.context_length": 131072, "gemma3.embedding_length": 2560}
    g = kv_geometry(gemma)
    assert g["layers"] == 34 and g["swa_layers"] == 34 - 6; ok += 1
    # hand calc: per layer-token = 4*(256+256)*2 = 4096 B; 6 global layers*32768 + 28 SWA layers*1024
    expect = 4096 * (6 * 32768 + 28 * 1024) / GB
    assert abs(kv_cache_gb(g, 32768) - expect) < 1e-9; ok += 1
    assert abs(kv_cache_gb(g, 32768, 4) - 4 * expect) < 1e-9; ok += 1
    assert kv_cache_gb(g, 32768, 1, "q8_0") < kv_cache_gb(g, 32768); ok += 1
    llama = {"general.architecture": "llama", "llama.block_count": 28, "llama.attention.head_count": 24,
             "llama.attention.head_count_kv": 8, "llama.embedding_length": 3072}
    gl = kv_geometry(llama)
    assert gl["k_len"] == 128 and gl["swa_layers"] == 0; ok += 1
    assert abs(kv_cache_gb(gl, 8192) - 28 * 8 * 256 * 2 * 8192 / GB) < 1e-9; ok += 1
    assert fit_status(5, 10.7) == "fits" and fit_status(10, 10.7) == "tight" and fit_status(12.8, 10.7) == "spills"; ok += 1
    assert fit_status(5, None) == "cpu"; ok += 1
    print(f"model_fit self-test: {ok}/{ok} checks passed")


if __name__ == "__main__":
    _selftest()
