"""Snapshot of the conditions an alignment test ran under (model, system, prompts).

Stored in the test JSON as `run_conditions` so a test can be reported on and
reproduced by someone else. Prompt skeletons are built with the same builders
the runner uses (alignment_runner.build_*), with a placeholder where the case goes.
"""

import os
import platform
from datetime import datetime, timezone

import requests

from config import APP_VERSION

CASE_PLACEHOLDER = "[CASE TEXT INSERTED HERE]"
CONTEXT_BEFORE_PLACEHOLDER = "[CONTEXT BEFORE, if any]"
CONTEXT_AFTER_PLACEHOLDER = "[CONTEXT AFTER, if any]"


def _system_info():
    info = {
        "os": f"{platform.system()} {platform.release()}",
        "os_version": platform.version(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
    }
    try:  # RAM via POSIX sysconf (macOS/Linux); skipped silently elsewhere
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        info["ram_gb"] = round(pages * page_size / (1024 ** 3), 1)
    except (ValueError, OSError, AttributeError):
        info["ram_gb"] = None
    return info


def _ollama_info(client):
    out = {"version": None, "model_details": None}
    try:
        r = requests.get(f"{client.base_url}/api/version", timeout=3)
        if r.status_code == 200:
            out["version"] = r.json().get("version")
    except Exception:
        pass
    try:
        r = requests.post(f"{client.base_url}/api/show", json={"model": client.model}, timeout=5)
        if r.status_code == 200:
            d = r.json().get("details", {}) or {}
            out["model_details"] = {
                "family": d.get("family"),
                "parameter_size": d.get("parameter_size"),
                "quantization_level": d.get("quantization_level"),
                "format": d.get("format"),
            }
    except Exception:
        pass
    return out


def _messages(*pairs):
    return [{"role": role, "content": content} for role, content in pairs]


def _skeleton(block_type, prompts, templates, unit_type):
    """Ordered list of steps, each with the exact message structure sent before a case is added."""
    from services.alignment_runner import (
        build_unit_user_content, build_source_system, build_rubric_system,
    )
    from services.prompt_template_service import render_template

    steps = []

    if block_type == "sourceAnalysis":
        sa = templates.get("sourceAnalysis", {})
        det_t, lab_t = sa.get("detection", {}), sa.get("labeling", {})
        user = build_unit_user_content(
            det_t, unit_type, CASE_PLACEHOLDER, CONTEXT_BEFORE_PLACEHOLDER, CONTEXT_AFTER_PLACEHOLDER)
        system = build_source_system(det_t, prompts.get("detection_prompt", ""))
        steps.append({
            "name": "1. Detection (TRUE/FALSE)",
            "max_tokens": 10,
            "messages": _messages(("system", system), ("user", user)),
        })
        steps.append({
            "name": "1b. Detection reasoning (follow-up in same conversation)",
            "max_tokens": 60,
            "messages": _messages(
                ("assistant", "[MODEL'S TRUE/FALSE ANSWER]"),
                ("user", render_template(
                    det_t.get("reasoningPrompt", "Provide your reasoning for this response in fewer than {{reasoningWords}} words."),
                    {"reasoningWords": det_t.get("reasoningWords", 20)})),
            ),
        })
        steps.append({
            "name": "2. Labeling (only if detection is TRUE and confidence >= detection threshold; "
                    "continues the same conversation as step 1)",
            "max_tokens": 50,
            "messages": _messages(
                ("assistant", "[MODEL'S TRUE/FALSE ANSWER]"),
                ("user", prompts.get("label_prompt", "")),
            ),
        })
        steps.append({
            "name": "2b. Label reasoning (follow-up)",
            "max_tokens": 60,
            "messages": _messages(
                ("assistant", "[MODEL'S LABEL]"),
                ("user", render_template(
                    lab_t.get("reasoningPrompt", "Provide your reasoning for giving this label in fewer than {{reasoningWords}} words."),
                    {"reasoningWords": lab_t.get("reasoningWords", 20)})),
            ),
        })

    elif block_type == "rubricAnalysis":
        scoring_t = templates.get("rubricAnalysis", {}).get("scoring", {})
        user = build_unit_user_content(
            scoring_t, unit_type, CASE_PLACEHOLDER, CONTEXT_BEFORE_PLACEHOLDER, CONTEXT_AFTER_PLACEHOLDER)
        for i, item in enumerate(prompts.get("rubric_items", []) or []):
            steps.append({
                "name": f"Rubric item {i + 1}: {item.get('title') or '(untitled)'}",
                "max_tokens": 50,
                "messages": _messages(("system", build_rubric_system(scoring_t, item)), ("user", user)),
            })

    elif block_type == "themeIdent":
        from services.alignment_runner import build_theme_messages
        comp_t = templates.get("themeIdent", {}).get("themeComparison", {})
        steps.append({
            "name": "Theme comparison (repeated once per theme in the frozen theme list)",
            "max_tokens": 5,
            "messages": build_theme_messages(
                comp_t, "[CASE LABEL]", "[CASE RATIONALE]",
                {"theme_title": "[THEME TITLE]", "description": "[THEME DESCRIPTION]"}),
        })

    elif block_type == "categoryBuild":
        cat_t = templates.get("categoryBuild", {}).get("categorization", {})
        steps.append({
            "name": "Categorization (single call over the full theme list)",
            "max_tokens": 1024,
            "messages": _messages(
                ("system", render_template(cat_t.get("systemTemplate", ""), {"maxCategories": prompts.get("max_categories", "[MAX CATEGORIES]")})),
                ("user", render_template(cat_t.get("userTemplate", ""), {"themeSummary": "[THEME LIST]"})),
            ),
        })

    elif block_type == "customPrompt":
        exec_t = templates.get("customPrompt", {}).get("execution", {})
        steps.append({
            "name": "Custom prompt (single call over the input data)",
            "max_tokens": 2048,
            "messages": _messages(
                ("system", render_template(exec_t.get("systemTemplate", "{{blockPrompt}}"), {"blockPrompt": prompts.get("prompt") or "[BLOCK PROMPT]"})),
                ("user", render_template(exec_t.get("userTemplate", "{{inputData}}"), {"inputData": "[INPUT DATA]"})),
            ),
        })

    return steps


def execution_environment(client, parallel_slots=None):
    """Accelerator, Ollama server settings and live GPU residency — the things that
    can change floating-point results between otherwise identical runs."""
    env = {}
    try:
        from services.hardware_profile import detect, gpu_residency
        hp = detect()
        env["accelerator"] = {k: hp.get(k) for k in ("kind", "chip", "gpu_name", "unified_memory",
                                                    "total_ram_gb", "gpu_budget_gb", "budget_source")}
        res = gpu_residency(client.base_url) or []
        env["gpu_residency"] = next((r for r in res if r["name"] in (client.model, f"{client.model}:latest")
                                     or r["name"].split(":")[0] == client.model.split(":")[0]), None)
    except Exception as e:
        env["accelerator_error"] = str(e)
    try:
        from services.ollama_server import current_settings
        cs = current_settings()
        env["ollama_server"] = {"mode": cs["mode"], "settings": cs["live"] or cs["saved"],
                                "settings_source": "live" if cs["live"] else ("saved by QUAILS" if cs["saved"] else "Ollama defaults (not set)")}
    except Exception as e:
        env["ollama_server_error"] = str(e)
    from services.ollama_client import client_keep_alive
    env["keep_alive"] = client_keep_alive()
    if parallel_slots is not None:
        env["parallel_slots"] = parallel_slots
    return env


def collect_run_conditions(project_id, client, block_type, test_data, templates, unit_type="sentence"):
    prompts = test_data.get("prompts_snapshot") or {}
    return {
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "quails_version": APP_VERSION,
        "provider": "ollama",  # alignment runs always use the Ollama client
        "model": client.model,
        "base_url": client.base_url,
        "sampling": {
            "temperature": client.temperature,
            "seed": client.seed,
            "top_k": client.top_k,
            "top_p": client.top_p,
            "repeat_penalty": client.repeat_penalty,
            "num_ctx": client.num_ctx or "Ollama default",
            "thinking": "disabled (think=false)",
        },
        "thresholds": {
            k: prompts[k] for k in ("detection_threshold", "label_threshold") if k in prompts
        },
        "unit_type": unit_type,
        "ollama": _ollama_info(client),
        "system": _system_info(),
        "execution": execution_environment(client),
        "prompt_skeleton": _skeleton(block_type, prompts, templates, unit_type),
    }
