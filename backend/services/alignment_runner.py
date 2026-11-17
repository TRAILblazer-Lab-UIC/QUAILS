"""Alignment-specific LLM execution: run block prompts on sampled units + compute metrics."""

import os
import json
import threading
from datetime import datetime, timezone

from config import PROJECTS_DIR, OLLAMA_BASE_URL, SELECTED_MODEL


# ---------------------------------------------------------------------------
# Shared prompt builders — used by the run AND by the run-conditions report
# (run_conditions.py) so the recorded prompt structure can never drift from
# what is actually sent to the model.
# ---------------------------------------------------------------------------

def build_unit_user_content(task_t, unit_type, unit_text, context_before="", context_after=""):
    """User message for one case, assembled exactly as the production analysis
    (source_analysis.py / rubric_analysis.py) does: unitIntro, unit text, then
    pre-context and post-context (each stripped), newline-joined.

    (Before 2026-10 alignment runs placed the context around the text
    — intro, pre+text+post — so alignment tests with context did not send the
    same prompt as the real analysis.)"""
    from services.prompt_template_service import render_template
    unit_intro = render_template(task_t.get("unitIntro", ""), {"unitType": unit_type})
    pre_ctx = ""
    if context_before:
        pre_ctx = render_template(
            task_t.get("contextPreTemplate", "[Context before: {{preContext}}]\n"),
            {"preContext": context_before},
        ).strip()
    post_ctx = ""
    if context_after:
        post_ctx = render_template(
            task_t.get("contextPostTemplate", "\n[Context after: {{postContext}}]"),
            {"postContext": context_after},
        ).strip()
    return "\n".join(filter(None, [unit_intro, unit_text, pre_ctx, post_ctx])).strip()


def build_source_system(det_t, detection_prompt):
    from services.prompt_template_service import render_template
    return render_template(det_t.get("systemTemplate", "{{blockPrompt}}"), {"blockPrompt": detection_prompt})


def build_rubric_system(scoring_t, item):
    from services.prompt_template_service import render_template
    return render_template(
        scoring_t.get("systemTemplate", "Rubric item: {{rubricTitle}}\n\nDescription: {{rubricDescription}}\n\n{{blockPrompt}}"),
        {
            "rubricTitle": item.get("title", ""),
            "rubricDescription": item.get("description", ""),
            "blockPrompt": item.get("scoring_prompt", ""),
        },
    )


def build_theme_messages(comp_t, label, reasoning, theme):
    from services.prompt_template_service import render_template
    comp_system = comp_t.get(
        "systemTemplate",
        "You are evaluating whether a label belongs to a theme. Respond with only TRUE or FALSE.",
    )
    comp_user = render_template(
        comp_t.get(
            "userTemplate",
            "Label: {{label}}\nRationale: {{reasoning}}\n\nTheme: {{themeTitle}}\nDescription: {{themeDescription}}\n\nIs this label related to this theme?",
        ),
        {
            "label": label,
            "reasoning": reasoning,
            "themeTitle": theme.get("theme_title", ""),
            "themeDescription": theme.get("description", ""),
        },
    )
    return [
        {"role": "system", "content": comp_system},
        {"role": "user", "content": comp_user},
    ]


_active_runs = set()   # test_ids currently running (checked before restarting Ollama)


def run_alignment_test(project_id, test_id, socketio):
    """Background thread entry point: run LLM on sampled units and compute metrics."""
    from services.alignment_service import (
        get_test, create_or_update_test, _get_block,
        compute_detection_metrics, compute_label_similarity,
        compute_rubric_metrics, compute_theme_match_metrics, compute_overall_score,
    )
    from services.socket_logger import emit_log, emit_progress
    from services.ollama_client import OllamaClient
    from services.llm_utils import (
        extract_bool_confidence, extract_label_confidence, parse_label_response,
    )
    from services.prompt_template_service import get_effective_templates, render_template
    from services.similarity import text_similarity

    try:
        socketio.emit("alignment_started", {
            "project_id": project_id,
            "test_id": test_id,
        })

        test_data = get_test(project_id, test_id)
        if "error" in test_data:
            emit_log(socketio, f"Alignment test error: {test_data['error']}", "error", project_id)
            socketio.emit("alignment_complete", {"project_id": project_id, "test_id": test_id, "status": "error", "error": test_data["error"]})
            return

        block_id = test_data["block_id"]
        block_type = test_data.get("block_type", "sourceAnalysis")
        prompts = test_data.get("prompts_snapshot", {})
        sample_units = test_data.get("sample_units", [])
        total = len(sample_units)

        # Load project for LLM config
        proj_dir = os.path.join(PROJECTS_DIR, project_id)
        with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
            project = json.load(f)

        # single_output blocks (categoryBuild/customPrompt) run as one LLM call
        # over aggregate input, not per sampled unit — handle that path separately.
        if block_type in ("categoryBuild", "customPrompt"):
            _, block_data = _get_block(project_id, block_id)
            mp = _load_model_params(proj_dir)
            client = OllamaClient(
                base_url=project.get("llm", {}).get("base_url", OLLAMA_BASE_URL),
                model=os.environ.get("SELECTED_MODEL", SELECTED_MODEL),
                temperature=mp.get("temperature", 0),
                seed=mp.get("seed", 5),
                top_k=mp.get("top_k", 3),
                top_p=mp.get("top_p", 0.9),
                repeat_penalty=mp.get("repeat_penalty", 1.0),
            )
            emit_log(socketio, f"Running single-output comparison for {block_id} ({block_type})", "info", project_id)
            llm_output = _run_single_output(client, project_id, block_type, block_data or {})

            human_expected = test_data.get("human_expected", "") or ""
            similarity = text_similarity(human_expected, llm_output) if human_expected.strip() else None

            test_data["llm_output"] = llm_output
            test_data["run_conditions"] = _safe_conditions(
                project_id, client, block_type, test_data, get_effective_templates(project_id), "sentence"
            )
            test_data["metrics"] = {
                "single_output": {"similarity": similarity},
                "overall_score": round(similarity, 1) if similarity is not None else 0.0,
            }
            test_data["status"] = "complete"
            create_or_update_test(project_id, block_id, test_data)

            emit_log(socketio, "Single-output comparison complete", "info", project_id)
            socketio.emit("alignment_complete", {"project_id": project_id, "test_id": test_id, "status": "complete"})
            return

        if total == 0:
            emit_log(socketio, "No sample units to test", "error", project_id)
            socketio.emit("alignment_complete", {"project_id": project_id, "test_id": test_id, "status": "error", "error": "No sample units"})
            return

        mp = _load_model_params(proj_dir)

        client = OllamaClient(
            base_url=project.get("llm", {}).get("base_url", OLLAMA_BASE_URL),
            model=os.environ.get("SELECTED_MODEL", SELECTED_MODEL),
            temperature=mp.get("temperature", 0),
            seed=mp.get("seed", 5),
            top_k=mp.get("top_k", 3),
            top_p=mp.get("top_p", 0.9),
            repeat_penalty=mp.get("repeat_penalty", 1.0),
        )

        # Load prompt templates
        templates = get_effective_templates(project_id)
        unit_type = (test_data.get("source_config") or {}).get("unit_type") or "sentence"
        # Opt-in Throughput mode: >1 sends several cases to Ollama at once (may change
        # floating-point results slightly vs. one at a time).
        workers = max(1, min(int(test_data.get("parallel_slots") or 1), 8))

        client.warm_model()  # load once, at the same num_ctx as the real calls
        emit_log(socketio, f"Starting alignment test on {total} units ({block_type})"
                 + (f" — Throughput mode: {workers} cases in parallel" if workers > 1 else ""), "info", project_id)

        llm_results = {}

        if block_type == "sourceAnalysis":
            llm_results = _run_source_alignment(
                client, sample_units, prompts, templates, socketio, project_id, block_id, total, unit_type,
                workers=workers,
            )
        elif block_type == "rubricAnalysis":
            rubric_items = prompts.get("rubric_items", [])
            llm_results = _run_rubric_alignment(
                client, sample_units, prompts, rubric_items, templates, socketio, project_id, block_id, total, unit_type,
                workers=workers,
            )
        elif block_type == "themeIdent":
            theme_reference_list = test_data.get("theme_reference_list", [])
            _, block_data = _get_block(project_id, block_id)
            theme_threshold = (block_data or {}).get("theme_threshold", 80.0)
            llm_results = _run_theme_alignment(
                client, sample_units, theme_reference_list, templates, theme_threshold,
                socketio, project_id, block_id, total, workers=workers,
            )

        # Compute metrics
        human_labels = test_data.get("human_labels", {})
        metrics = {}

        if block_type == "sourceAnalysis":
            metrics["detection"] = compute_detection_metrics(human_labels, llm_results)
            metrics["labels"] = compute_label_similarity(
                human_labels, llm_results,
                test_data.get("similarity_threshold")
            )
        elif block_type == "rubricAnalysis":
            rubric_items = prompts.get("rubric_items", [])
            metrics["rubric_scores"] = compute_rubric_metrics(
                human_labels, llm_results, rubric_items,
                test_data.get("rubric_match_mode", "exact")
            )
        elif block_type == "themeIdent":
            metrics["theme_match"] = compute_theme_match_metrics(human_labels, llm_results)

        metrics["overall_score"] = compute_overall_score(metrics)

        # Update test file with results
        test_data["llm_results"] = llm_results
        test_data["metrics"] = metrics
        test_data["run_conditions"] = _safe_conditions(project_id, client, block_type, test_data, templates, unit_type)
        test_data["run_conditions"]["parallel_slots"] = workers
        test_data["status"] = "complete"

        create_or_update_test(project_id, block_id, test_data)

        emit_log(socketio, f"Alignment test complete — overall score: {metrics['overall_score']}%", "info", project_id)
        socketio.emit("alignment_complete", {
            "project_id": project_id,
            "test_id": test_id,
            "status": "complete",
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        from services.socket_logger import emit_log as el
        el(socketio, f"Alignment test failed: {str(e)}", "error", project_id)
        socketio.emit("alignment_complete", {
            "project_id": project_id,
            "test_id": test_id,
            "status": "error",
            "error": str(e),
        })


def _run_source_alignment(client, sample_units, prompts, templates, socketio, project_id, block_id, total,
                          unit_type="sentence", should_stop=None, workers=1):
    """Run sourceAnalysis prompts on sample units.

    workers=1 (default) processes units one at a time — the replicable path.
    workers>1 is opt-in Throughput mode (see services/parallel.py); results and
    logs are still produced in sample order.
    """
    from services.socket_logger import emit_log, emit_progress
    from services.llm_utils import extract_bool_confidence, extract_label_confidence, parse_label_response
    from services.prompt_template_service import render_template
    from services.parallel import ordered_map

    sa = templates.get("sourceAnalysis", {})
    det_t = sa.get("detection", {})
    lab_t = sa.get("labeling", {})

    detection_prompt = prompts.get("detection_prompt", "")
    label_prompt = prompts.get("label_prompt", "")
    detection_threshold = prompts.get("detection_threshold", 70.0)

    def one(unit):
        unit_text = unit.get("text", "")
        cb = unit.get("context_before", "")
        ca = unit.get("context_after", "")

        user_content = build_unit_user_content(det_t, unit_type, unit_text, cb, ca)
        system_content = build_source_system(det_t, detection_prompt)

        # Step 1: Detection
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        result = client.chat(messages, temperature=0.1, num_predict=10, logprobs=True)
        if result.get("error"):
            return None, (f"LLM error on {unit['unit_id']}: {result['error']}", "error")

        response_text = (result.get("content") or "").strip().upper()
        is_true = "TRUE" in response_text
        detection_conf = extract_bool_confidence(result.get("logprobs", []), is_true)

        # Step 1b: Detection reasoning
        det_reasoning_prompt = render_template(
            det_t.get("reasoningPrompt", "Provide your reasoning for this response in fewer than {{reasoningWords}} words."),
            {"reasoningWords": det_t.get("reasoningWords", 20)},
        )
        reasoning_result = client.chat(
            messages + [
                {"role": "assistant", "content": result["content"]},
                {"role": "user", "content": det_reasoning_prompt},
            ],
            temperature=0.1, num_predict=60, logprobs=False,
        )
        reasoning = (reasoning_result.get("content") or "").strip()

        unit_result = {
            "detection": "TRUE" if is_true else "FALSE",
            "detection_confidence": round(detection_conf, 1),
            "labels": [],
            "label_confidence": 0,
            "reasoning": reasoning,
        }

        # Step 2: Labeling (if TRUE and confidence above threshold)
        if is_true and detection_conf >= detection_threshold:
            messages.append({"role": "assistant", "content": result["content"]})
            messages.append({"role": "user", "content": label_prompt})

            label_result = client.chat(messages, temperature=0.1, num_predict=50, logprobs=True)
            if not label_result.get("error"):
                label_text = (label_result.get("content") or "").strip()
                label, _ = parse_label_response(label_text)
                label_conf = extract_label_confidence(label_result.get("logprobs", []))

                # Support comma-separated labels
                labels = [l.strip() for l in label.split(",") if l.strip()]
                unit_result["labels"] = labels
                unit_result["label_confidence"] = round(label_conf, 1)

                # Label reasoning
                lab_reasoning_prompt = render_template(
                    lab_t.get("reasoningPrompt", "Provide your reasoning for giving this label in fewer than {{reasoningWords}} words."),
                    {"reasoningWords": lab_t.get("reasoningWords", 20)},
                )
                lab_reasoning_result = client.chat(
                    messages + [
                        {"role": "assistant", "content": label_result["content"]},
                        {"role": "user", "content": lab_reasoning_prompt},
                    ],
                    temperature=0.1, num_predict=60, logprobs=False,
                )
                unit_result["reasoning"] = (lab_reasoning_result.get("content") or "").strip()

        snippet = unit_text[:50].replace("\n", " ")
        label_str = ", ".join(unit_result["labels"]) if unit_result["labels"] else ""
        return unit_result, (f'[{unit_result["detection"]}] {unit["unit_id"]} — "{snippet}..." {label_str} (conf: {detection_conf:.0f}%)', "info")

    llm_results = {}
    for i, (unit, (unit_result, log)) in enumerate(ordered_map(one, sample_units, workers, should_stop)):
        emit_progress(socketio, block_id, i + 1, total, project_id)
        if unit_result is not None:
            llm_results[unit["unit_id"]] = unit_result
        emit_log(socketio, log[0], log[1], project_id)

    return llm_results


def _run_rubric_alignment(client, sample_units, prompts, rubric_items, templates, socketio, project_id, block_id, total,
                          unit_type="sentence", should_stop=None, workers=1):
    """Run rubricAnalysis prompts on sample units (workers>1 = opt-in Throughput mode)."""
    from services.socket_logger import emit_log, emit_progress
    from services.llm_utils import extract_label_confidence, parse_label_response
    from services.parallel import ordered_map

    ra = templates.get("rubricAnalysis", {})
    scoring_t = ra.get("scoring", {})
    label_threshold = prompts.get("label_threshold", 70.0)

    def one(unit):
        unit_text = unit.get("text", "")
        cb = unit.get("context_before", "")
        ca = unit.get("context_after", "")

        user_content = build_unit_user_content(scoring_t, unit_type, unit_text, cb, ca)

        rubric_scores = {}
        rubric_confidences = {}
        rubric_justifications = {}
        logs = []

        for r_idx, item in enumerate(rubric_items):
            rubric_key = f"rubric_{r_idx + 1}"

            system_content = build_rubric_system(scoring_t, item)

            messages = [
                {"role": "system", "content": system_content},
                {"role": "user", "content": user_content},
            ]
            result = client.chat(messages, temperature=0.1, num_predict=50, logprobs=True)

            if result.get("error"):
                logs.append((f"LLM error on {unit['unit_id']} rubric {r_idx+1}: {result['error']}", "error"))
                continue

            score_text, justification = parse_label_response(result["content"].strip())
            label_conf = extract_label_confidence(result.get("logprobs", []))

            rubric_scores[rubric_key] = score_text if label_conf >= label_threshold else ""
            rubric_confidences[rubric_key] = round(label_conf, 1)
            rubric_justifications[rubric_key] = justification[:80]

            logs.append((f"[RUBRIC] {unit['unit_id']} — {rubric_key}: {score_text if label_conf >= label_threshold else '—'} (conf: {label_conf:.0f}%)", "info"))

        return {
            "rubric_scores": rubric_scores,
            "rubric_confidences": rubric_confidences,
            "rubric_justifications": rubric_justifications,
        }, logs

    llm_results = {}
    for i, (unit, (unit_result, logs)) in enumerate(ordered_map(one, sample_units, workers, should_stop)):
        emit_progress(socketio, block_id, i + 1, total, project_id)
        for msg, level in logs:
            emit_log(socketio, msg, level, project_id)
        llm_results[unit["unit_id"]] = unit_result

    return llm_results


def _safe_conditions(project_id, client, block_type, test_data, templates, unit_type):
    """Snapshot run conditions; never let a reporting failure fail the test run."""
    try:
        from services.run_conditions import collect_run_conditions
        return collect_run_conditions(project_id, client, block_type, test_data, templates, unit_type)
    except Exception as e:
        return {"error": f"Could not record run conditions: {e}"}


def _load_model_params(proj_dir):
    """Read LLM sampling params from the projectSpec node in flow.json."""
    flow_path = os.path.join(proj_dir, "flow.json")
    if not os.path.exists(flow_path):
        return {}
    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)
    spec_node = next((n for n in flow.get("nodes", []) if n.get("type") == "projectSpec"), None)
    if not spec_node:
        return {}
    sd = spec_node.get("data", {})
    return {
        "temperature": sd.get("temperature", 0),
        "seed": sd.get("seed", 5),
        "top_k": sd.get("top_k", 3),
        "top_p": sd.get("top_p", 0.9),
        "repeat_penalty": sd.get("repeat_penalty", 1.0),
    }


def _run_theme_alignment(client, sample_units, theme_reference_list, templates, threshold,
                          socketio, project_id, block_id, total, should_stop=None, workers=1):
    """Compare each sampled row's label against a frozen theme list (v1 approximation
    of themeIdent's normally sequential constant-comparison algorithm — see
    generate_theme_sample() docstring). Rows are independent here (the theme list
    is frozen), so workers>1 (opt-in Throughput mode) is safe to apply per row."""
    from services.socket_logger import emit_log, emit_progress
    from services.theme_identifier import _extract_conf
    from services.parallel import ordered_map

    ti = templates.get("themeIdent", {})
    comp_t = ti.get("themeComparison", {})

    def one(unit):
        label = unit.get("label", "")
        reasoning = unit.get("reasoning", "")

        best_theme_id = None
        best_conf = 0

        for theme in theme_reference_list:
            messages = build_theme_messages(comp_t, label, reasoning, theme)
            result = client.chat(messages, temperature=0.1, num_predict=5, logprobs=True)
            if result.get("error"):
                continue

            response = (result.get("content") or "").strip().upper()
            if "TRUE" in response:
                conf = _extract_conf(result.get("logprobs", []))
                if conf > best_conf:
                    best_conf = conf
                    best_theme_id = theme.get("theme_id")

        theme_choice = best_theme_id if (best_theme_id and best_conf >= threshold) else "NEW"
        return {"theme_choice": theme_choice, "confidence": round(best_conf, 1)}, best_conf

    llm_results = {}
    for i, (unit, (res, best_conf)) in enumerate(ordered_map(one, sample_units, workers, should_stop)):
        emit_progress(socketio, block_id, i + 1, total, project_id)
        llm_results[unit["unit_id"]] = res
        emit_log(socketio, f'[THEME] {unit["unit_id"]} → {res["theme_choice"]} (conf: {best_conf:.0f}%)', "info", project_id)

    return llm_results


def _run_single_output(client, project_id, block_type, block_data):
    """Execute a single-call block's own LLM call (categoryBuild/customPrompt) without
    writing its production output file — used only to produce a comparison value
    for alignment testing. Deliberately mirrors category_builder.py / custom_prompt.py
    rather than importing them, since those modules' side effects (writing the real
    block output file, committing to version control) must not fire from a test run.
    """
    import csv as csv_mod
    from services.prompt_template_service import get_effective_templates, render_template

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    templates = get_effective_templates(project_id)

    if block_type == "customPrompt":
        custom_prompt = block_data.get("prompt", "")
        input_text = ""
        input_source = block_data.get("input_source", "")
        if input_source and os.path.exists(input_source):
            with open(input_source, "r", encoding="utf-8") as f:
                input_text = f.read()
        elif block_data.get("input_block_id"):
            input_block = block_data["input_block_id"]
            input_dir = os.path.join(proj_dir, "blocks", input_block)
            if os.path.exists(input_dir):
                for fname in os.listdir(input_dir):
                    if fname.endswith(".csv") or fname.endswith(".md"):
                        with open(os.path.join(input_dir, fname), "r", encoding="utf-8") as f:
                            input_text += f"\n--- {fname} ---\n{f.read()}"

        cp = templates.get("customPrompt", {})
        exec_t = cp.get("execution", {})
        system_content = render_template(exec_t.get("systemTemplate", "{{blockPrompt}}"), {"blockPrompt": custom_prompt})
        user_content = render_template(exec_t.get("userTemplate", "{{inputData}}"), {"inputData": input_text or "No input data provided."})
        result = client.chat(
            [{"role": "system", "content": system_content}, {"role": "user", "content": user_content}],
            temperature=0.3, num_predict=2048,
        )
        return result.get("content", "") if not result.get("error") else f"[LLM error: {result['error']}]"

    if block_type == "categoryBuild":
        max_categories = block_data.get("max_categories", 6)
        input_block = block_data.get("input_block_id", "")
        themes_path = os.path.join(proj_dir, "blocks", input_block, f"{input_block}_themes.csv") if input_block else ""
        if not themes_path or not os.path.exists(themes_path):
            return "[No upstream theme list available — run the theme identification block first]"

        with open(themes_path, "r", encoding="utf-8", newline="") as f:
            themes = list(csv_mod.DictReader(f))
        theme_summary = "\n".join(
            f"- {t.get('theme_id', '')}: {t.get('theme_title', '')} - {t.get('description', '')}"
            for t in themes
        )

        cb_t = templates.get("categoryBuild", {})
        cat_t = cb_t.get("categorization", {})
        system_content = render_template(
            cat_t.get("systemTemplate", "You are organizing research themes into categories. Create at most {{maxCategories}} categories. For each category, provide a title and list which themes belong to it. Format as markdown."),
            {"maxCategories": max_categories},
        )
        user_content = render_template(
            cat_t.get("userTemplate", "Organize these themes into categories:\n\n{{themeSummary}}"),
            {"themeSummary": theme_summary},
        )
        result = client.chat(
            [{"role": "system", "content": system_content}, {"role": "user", "content": user_content}],
            temperature=0.3, num_predict=1024,
        )
        return result.get("content", "") if not result.get("error") else f"[LLM error: {result['error']}]"

    return f"[Unsupported block type for single_output comparison: {block_type}]"


def start_alignment_thread(project_id, test_id):
    """Launch alignment test in a background thread."""
    from extensions import socketio

    def _run():
        _active_runs.add(test_id)
        try:
            run_alignment_test(project_id, test_id, socketio)
        finally:
            _active_runs.discard(test_id)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
