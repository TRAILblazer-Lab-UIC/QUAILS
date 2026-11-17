"""Detect the machine's accelerator and how much memory the GPU can actually use.

Unified-memory machines (Apple Silicon, NVIDIA GB10 / DGX Spark / ASUS Ascent GX10,
AMD Ryzen AI Max "Strix Halo") let the GPU address most of system RAM, so the
model-fit budget is derived from RAM rather than from a separate VRAM figure.
Detection is best-effort; Ollama's /api/ps (size_vram vs size) is the ground
truth for whether a loaded model actually runs on the GPU.
"""

import os
import platform
import re
import shutil
import subprocess

import requests

from config import OLLAMA_BASE_URL

GB = 1024 ** 3
UNIFIED_NVIDIA_PATTERN = re.compile(r"\b(GB10|GH200|GB200|GB300|Thor|Orin)\b", re.IGNORECASE)

_cache = None


def _run(cmd, timeout=5):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _sysctl(name):
    return _run(["sysctl", "-n", name])


def _linux_mem_total_gb(meminfo_text=None):
    if meminfo_text is None:
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                meminfo_text = f.read()
        except OSError:
            return None
    m = re.search(r"^MemTotal:\s+(\d+)\s+kB", meminfo_text, re.MULTILINE)
    return round(int(m.group(1)) * 1024 / GB, 1) if m else None


def _ram_gb():
    if platform.system() == "Darwin":
        v = _sysctl("hw.memsize")
        return round(int(v) / GB, 1) if v.isdigit() else None
    if platform.system() == "Linux":
        return _linux_mem_total_gb()
    try:
        return round(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / GB, 1)
    except (ValueError, OSError, AttributeError):
        return None


def apple_default_wired_fraction(ram_gb):
    """macOS lets the GPU wire roughly 2/3 of RAM on smaller machines and 3/4 above ~36 GB."""
    return 0.67 if (ram_gb or 0) <= 36 else 0.75


def os_reserve_gb(ram_gb):
    return max(8.0, 0.06 * (ram_gb or 0))


def parse_nvidia_smi(text):
    """Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` output."""
    gpus = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if not parts or not parts[0]:
            continue
        name = parts[0]
        mem = parts[1] if len(parts) > 1 else ""
        m = re.match(r"([\d.]+)\s*MiB", mem)
        gpus.append({"name": name, "memory_gb": round(float(m.group(1)) / 1024, 1) if m else None,
                     "memory_reported": bool(m)})
    return gpus


def classify(system, machine, ram_gb, nvidia_text="", cpuinfo_text="", wired_limit_mb=None, chip=None):
    """Pure classification (separated from probing so it can be tested with fixtures)."""
    notes = []
    profile = {"os": system, "arch": machine, "total_ram_gb": ram_gb, "chip": chip,
               "gpu_name": None, "unified_memory": False, "gpu_budget_gb": None,
               "budget_source": None, "kind": "cpu", "notes": notes}

    if system == "Darwin" and machine == "arm64":
        profile.update(kind="apple_unified", unified_memory=True, gpu_name=chip or "Apple Silicon GPU (Metal)")
        if wired_limit_mb and wired_limit_mb > 0:
            profile["gpu_budget_gb"] = round(wired_limit_mb / 1024, 1)
            profile["budget_source"] = "iogpu.wired_limit_mb (user-set GPU wired-memory limit)"
        elif ram_gb:
            frac = apple_default_wired_fraction(ram_gb)
            profile["gpu_budget_gb"] = round(ram_gb * frac, 1)
            profile["budget_source"] = f"estimated macOS default (~{int(frac * 100)}% of RAM)"
        notes.append("Unified memory: the GPU shares system RAM, so other open apps reduce what models can use.")
        return profile

    gpus = parse_nvidia_smi(nvidia_text)
    if gpus:
        g = gpus[0]
        profile["gpu_name"] = g["name"]
        if UNIFIED_NVIDIA_PATTERN.search(g["name"]) or not g["memory_reported"]:
            profile.update(kind="nvidia_unified", unified_memory=True)
            if ram_gb:
                profile["gpu_budget_gb"] = round(ram_gb - os_reserve_gb(ram_gb), 1)
                profile["budget_source"] = f"system RAM minus ~{os_reserve_gb(ram_gb):.0f} GB OS reserve (unified memory)"
            notes.append("NVIDIA unified memory (e.g. GB10 / DGX Spark): CPU and GPU share LPDDR5x; nvidia-smi does not report a separate VRAM size.")
        else:
            profile.update(kind="discrete_gpu", gpu_budget_gb=round(sum(x["memory_gb"] or 0 for x in gpus), 1),
                           budget_source=f"VRAM reported by nvidia-smi ({len(gpus)} GPU{'s' if len(gpus) > 1 else ''})")
        return profile

    if re.search(r"Ryzen AI Max", cpuinfo_text or "", re.IGNORECASE):
        profile.update(kind="amd_unified", unified_memory=True, gpu_name="AMD Radeon (Strix Halo iGPU)")
        if ram_gb:
            profile["gpu_budget_gb"] = round(ram_gb - os_reserve_gb(ram_gb), 1)
            profile["budget_source"] = "system RAM minus OS reserve (unified memory; depends on BIOS/GTT settings)"
        notes.append("Experimental: AMD unified-memory support in Ollama depends on ROCm/Vulkan and the BIOS memory split.")
        return profile

    profile["budget_source"] = "no GPU detected; models run on CPU from system RAM"
    profile["gpu_budget_gb"] = None
    notes.append("No supported GPU detected. Inference will run on the CPU, which is much slower.")
    return profile


def detect(refresh=False):
    global _cache
    if _cache is not None and not refresh:
        return _cache
    system, machine = platform.system(), platform.machine()
    ram = _ram_gb()
    chip = None
    wired = None
    nvidia = cpuinfo = ""
    if system == "Darwin":
        chip = _sysctl("machdep.cpu.brand_string") or None
        w = _sysctl("iogpu.wired_limit_mb")
        wired = int(w) if w.isdigit() else None
    else:
        if shutil.which("nvidia-smi"):
            nvidia = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
        try:
            with open("/proc/cpuinfo", "r", encoding="utf-8") as f:
                cpuinfo = f.read()
            m = re.search(r"^model name\s*:\s*(.+)$", cpuinfo, re.MULTILINE)
            chip = m.group(1).strip() if m else None
        except OSError:
            pass
    _cache = classify(system, machine, ram, nvidia, cpuinfo, wired, chip)
    return _cache


def gpu_residency(base_url=OLLAMA_BASE_URL):
    """Loaded models and how much of each sits in GPU memory (Ollama /api/ps)."""
    try:
        r = requests.get(f"{base_url}/api/ps", timeout=3)
        models = r.json().get("models", []) if r.status_code == 200 else []
    except Exception:
        return None
    out = []
    for m in models:
        size, vram = m.get("size") or 0, m.get("size_vram") or 0
        out.append({"name": m.get("name"), "size_gb": round(size / GB, 2), "vram_gb": round(vram / GB, 2),
                    "gpu_fraction": round(vram / size, 3) if size else None,
                    "context_length": m.get("context_length"), "expires_at": m.get("expires_at")})
    return out


def _selftest():
    ok = 0
    p = classify("Darwin", "arm64", 16.0, wired_limit_mb=0, chip="Apple M4")
    assert p["kind"] == "apple_unified" and p["gpu_budget_gb"] == 10.7, p; ok += 1
    p = classify("Darwin", "arm64", 64.0, wired_limit_mb=57344)
    assert p["gpu_budget_gb"] == 56.0 and "wired_limit" in p["budget_source"]; ok += 1
    p = classify("Darwin", "arm64", 128.0, wired_limit_mb=None)
    assert p["gpu_budget_gb"] == 96.0; ok += 1
    p = classify("Linux", "aarch64", 119.7, nvidia_text="NVIDIA GB10, [N/A]")
    assert p["kind"] == "nvidia_unified" and p["unified_memory"] and p["gpu_budget_gb"] == round(119.7 - 8.0, 1), p; ok += 1
    p = classify("Linux", "x86_64", 64.0, nvidia_text="NVIDIA GeForce RTX 4090, 24564 MiB")
    assert p["kind"] == "discrete_gpu" and p["gpu_budget_gb"] == 24.0; ok += 1
    p = classify("Linux", "x86_64", 128.0, cpuinfo_text="model name : AMD RYZEN AI MAX+ 395 w/ Radeon 8060S")
    assert p["kind"] == "amd_unified"; ok += 1
    p = classify("Linux", "x86_64", 32.0)
    assert p["kind"] == "cpu" and p["gpu_budget_gb"] is None; ok += 1
    assert _linux_mem_total_gb("MemTotal:       125509768 kB\nMemFree: 1 kB") == 119.7; ok += 1
    print(f"hardware_profile self-test: {ok}/{ok} checks passed")
    print("this machine:", detect())


if __name__ == "__main__":
    _selftest()
