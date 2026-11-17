"""Block Type 1: Two-step LLM open-coding analysis."""

import os
import csv
import json
from datetime import datetime

from config import PROJECTS_DIR, OLLAMA_BASE_URL, SELECTED_MODEL
from services.llm_utils import (
    load_all_units as _load_all_units,
    build_context_for_unit as _build_context_for_unit,
    group_sentences_by_paragraph as _group_sentences_by_paragraph,
    build_paragraph_context_for_unit as _build_paragraph_context_for_unit,
    format_unit_content,
    open_csv as _open_csv,
    extract_bool_confidence as _extract_bool_confidence,
    extract_label_confidence as _extract_label_confidence,
    parse_label_response as _parse_label_response,
    resolve_doc_indices,
    resolve_split_delimiters,
)


def run_source_analysis(project_id, block_id, block_data, model_params=None):
    """Execute open-coding analysis (Block Type 1).

    Two-step evaluation per unit:
    Step 1: TRUE/FALSE detection with confidence
    Step 2: Label assignment with confidence
    """
    from services.ollama_client import OllamaClient
    from services.confidence_scorer import logprob_to_confidence
    from services.save_state import load_state, save_state
    from services.analysis_engine import is_stopped
    from services.socket_logger import emit_log, emit_progress
    from services.prompt_template_service import get_effective_templates, render_template
    from services.parallel import ordered_map
    from services.llm_utils import analysis_workers as _analysis_workers, write_run_environment as _write_run_environment
    from extensions import socketio

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_dir = os.path.join(proj_dir, "blocks", block_id)

    # Load project config
    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project = json.load(f)

    mp = model_params or {}
    client = OllamaClient(
        base_url=project.get("llm", {}).get("base_url", OLLAMA_BASE_URL),
        model=os.environ.get("SELECTED_MODEL", SELECTED_MODEL),
        temperature=mp.get("temperature", 0),
        seed=mp.get("seed", 5),
        top_k=mp.get("top_k", 3),
        top_p=mp.get("top_p", 0.9),
        repeat_penalty=mp.get("repeat_penalty", 1.0),
    )

    # Determine which docs to load based on source_type
    doc_indices = resolve_doc_indices(proj_dir, block_data)

    # Load all units from parsed documents, re-segmenting if block-level unit_type differs
    unit_type = block_data.get("unit_type", project.get("unit_type", "sentence"))
    units = _load_all_units(
        proj_dir, doc_indices=doc_indices, unit_type=unit_type, project_short=project["id"][:4],
        sentence_column=block_data.get("sentence_column"),
        sentence_split_method=block_data.get("sentence_split_method", "sentence"),
        sentence_split_delimiters=resolve_split_delimiters(block_data),
    )
    total = len(units)

    # Load or create save state
    state = load_state(block_dir)
    start_index = state.get("completed_count", 0)

    # Get prompts from block data
    detection_prompt = block_data.get("detection_prompt", project.get("detection_prompt",
        "Analyze the following text unit. Does it contain content relevant to the research question? Respond with only TRUE or FALSE."))
    label_prompt = block_data.get("label_prompt", project.get("label_prompt",
        "Based on the text unit above, assign a single descriptive label that captures the key theme or concept. Respond with only the label."))

    detection_threshold = block_data.get("detection_threshold",
        project.get("thresholds", {}).get("detection", 70.0))
    label_threshold = block_data.get("label_threshold",
        project.get("thresholds", {}).get("label", 70.0))

    # Load prompt templates
    templates = get_effective_templates(project_id)
    sa = templates.get("sourceAnalysis", {})
    det_t = sa.get("detection", {})
    lab_t = sa.get("labeling", {})

    # Open CSVs in append mode
    labels_path = os.path.join(block_dir, f"{block_id}_labels.csv")
    false_path = os.path.join(block_dir, f"{block_id}_false.csv")

    labels_file, labels_writer = _open_csv(labels_path, start_index == 0,
        ["line_number", "unit_id", "doc_index", "filename", "detection_confidence", "label", "reasoning", "label_confidence", "timestamp"])
    false_file, false_writer = _open_csv(false_path, start_index == 0,
        ["id", "unit_id", "doc_index", "filename", "false_confidence", "reasoning", "timestamp"])

    line_number = start_index
    selected_columns = block_data.get("selected_columns") or []

    # "Full Paragraph"/"Full Cell" context mode — passes the whole paragraph
    # (or, for a sentence_column cell-split, the whole cell) a unit belongs to
    # (split before/after around it) instead of N neighboring units. Grouped
    # once up front rather than per-unit to avoid an O(n^2) scan over a full
    # run. Meaningful for document-level sentence analysis (unit_type ==
    # "sentence") and for cell-level sentence/delimiter splitting
    # (sentence_column set) — the latter forces unit_type to "line" at the
    # block level even though the actual analyzed units are R-type sentence
    # sub-units, so both conditions are checked.
    context_mode = block_data.get("context_mode", "units")
    paragraph_groups = (
        _group_sentences_by_paragraph(units)
        if context_mode == "paragraph" and (unit_type == "sentence" or block_data.get("sentence_column"))
        else None
    )

    # Log prompts and settings once at analysis start using configurable header template
    header_template = sa.get("consoleHeader", "")
    if header_template:
        header_vars = {
            "model": client.model,
            "numCtx": f"{client.num_ctx:,}" if client.num_ctx else "default (2,048)",
            "temperature": client.temperature,
            "seed": client.seed,
            "topK": client.top_k,
            "topP": client.top_p,
            "repeatPenalty": client.repeat_penalty,
            "unitType": unit_type,
            "detectionThreshold": detection_threshold,
            "labelThreshold": label_threshold,
            "totalUnits": total,
            "startIndex": start_index,
            "detectionPrompt": detection_prompt,
            "labelPrompt": label_prompt,
        }
        for line in render_template(header_template, header_vars).splitlines():
            emit_log(socketio, line, "info", project_id)
    else:
        emit_log(socketio, f"── Detection prompt ──────────────────────────────", "info", project_id)
        emit_log(socketio, detection_prompt, "info", project_id)
        emit_log(socketio, f"── Label prompt ──────────────────────────────────", "info", project_id)
        emit_log(socketio, label_prompt, "info", project_id)
        emit_log(socketio, f"── Settings ──────────────────────────────────────", "info", project_id)
        ctx_display = f"{client.num_ctx:,} tokens" if client.num_ctx else "default (2,048 tokens)"
        emit_log(socketio, f"Model: {client.model} | Context window: {ctx_display}", "info", project_id)
        emit_log(socketio, f"temperature={client.temperature} | seed={client.seed} | top_k={client.top_k} | top_p={client.top_p} | repeat_penalty={client.repeat_penalty}", "info", project_id)
        emit_log(socketio, f"Unit type: {unit_type} | Detection threshold: {detection_threshold}% | Label threshold: {label_threshold}%", "info", project_id)
        emit_log(socketio, f"Total units: {total} | Starting at: {start_index}", "info", project_id)
        emit_log(socketio, f"─────────────────────────────────────────────────", "info", project_id)

    # Opt-in parallel analysis (project setting, off by default). With workers > 1,
    # several units are sent to Ollama at once; outputs are still written, logged
    # and checkpointed strictly in unit order, so resume works the same — but
    # batching can change floating-point results (not byte-for-byte replicable).
    workers = _analysis_workers(project)
    _write_run_environment(block_dir, client, workers)
    client.warm_model()
    if workers > 1:
        emit_log(socketio, f"⚠ Parallel analysis: {workers} units in flight at once — outputs are not guaranteed "
                           "byte-for-byte replicable against a sequential run.", "warning", project_id)

    def compute(i):
        """All LLM calls for unit i (no file writes — those happen in order below)."""
        unit = units[i]

        # Build context — use structured row_data when available
        unit_text = format_unit_content(unit, selected_columns)

        if paragraph_groups is not None:
            cb, ca = _build_paragraph_context_for_unit(unit, paragraph_groups)
        else:
            block_context_window = block_data.get("context_window")
            if block_context_window is not None:
                cb, ca = _build_context_for_unit(units, i, int(block_context_window))
            else:
                cb, ca = unit.get("context_before", ""), unit.get("context_after", "")

        # Build unit intro
        unit_intro = render_template(
            det_t.get("unitIntro", ""),
            {"unitType": unit_type},
        )

        # Build context framing with configurable templates
        pre_ctx_text = ""
        if cb:
            pre_ctx_text = render_template(
                det_t.get("contextPreTemplate", "[Context before: {{preContext}}]\n"),
                {"preContext": cb},
            ).strip()

        post_ctx_text = ""
        if ca:
            post_ctx_text = render_template(
                det_t.get("contextPostTemplate", "\n[Context after: {{postContext}}]"),
                {"postContext": ca},
            ).strip()

        user_content = "\n".join(filter(None, [
            unit_intro,
            unit_text,
            pre_ctx_text,
            post_ctx_text,
        ])).strip()

        # Build detection system message from template
        system_content = render_template(
            det_t.get("systemTemplate", "{{blockPrompt}}"),
            {"blockPrompt": detection_prompt},
        )

        # Step 1: Detection (TRUE/FALSE) — fresh messages list per unit; no history from prior units
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

        result = client.chat(messages, temperature=0.1, num_predict=10, logprobs=True)
        if result.get("error"):
            return {"kind": "error", "message": f"LLM error on {unit['unit_id']}: {result['error']}"}

        response_text = (result.get("content") or "").strip().upper()
        is_true = "TRUE" in response_text

        # Extract detection confidence from logprobs
        detection_conf = _extract_bool_confidence(result.get("logprobs", []), is_true)

        # Step 1b: Ask for detection reasoning (all cases)
        det_reasoning_prompt = render_template(
            det_t.get("reasoningPrompt", "Provide your reasoning for this response in fewer than {{reasoningWords}} words."),
            {"reasoningWords": det_t.get("reasoningWords", 20)},
        )
        det_reasoning_result = client.chat(
            messages + [
                {"role": "assistant", "content": result["content"]},
                {"role": "user", "content": det_reasoning_prompt},
            ],
            temperature=0.1, num_predict=60, logprobs=False,
        )
        detection_reasoning = (det_reasoning_result.get("content") or "").strip()
        snippet = unit_text[:60].replace("\n", " ")

        if not is_true or detection_conf < detection_threshold:
            return {"kind": "false", "unit": unit, "is_true": is_true, "detection_conf": detection_conf,
                    "reasoning": detection_reasoning, "snippet": snippet}

        # Step 2: Labeling (continue same conversation)
        messages.append({"role": "assistant", "content": result["content"]})
        messages.append({"role": "user", "content": label_prompt})

        label_result = client.chat(messages, temperature=0.1, num_predict=50, logprobs=True)
        if label_result.get("error"):
            return {"kind": "error", "message": f"Label error on {unit['unit_id']}: {label_result['error']}"}

        label_text = (label_result.get("content") or "").strip()
        label, _ = _parse_label_response(label_text)
        label_conf = _extract_label_confidence(label_result.get("logprobs", []))

        # Step 2b: Ask for label reasoning
        lab_reasoning_prompt = render_template(
            lab_t.get("reasoningPrompt", "Provide your reasoning for giving this label in fewer than {{reasoningWords}} words."),
            {"reasoningWords": lab_t.get("reasoningWords", 20)},
        )
        label_reasoning_result = client.chat(
            messages + [
                {"role": "assistant", "content": label_result["content"]},
                {"role": "user", "content": lab_reasoning_prompt},
            ],
            temperature=0.1, num_predict=60, logprobs=False,
        )
        label_reasoning = (label_reasoning_result.get("content") or "").strip()
        return {"kind": "label", "unit": unit, "detection_conf": detection_conf, "label": label,
                "label_conf": label_conf, "reasoning": label_reasoning, "snippet": snippet}

    unit_log_template = sa.get("consoleUnit", '[{{verdict}}] {{unitId}} — "{{snippet}}..." → {{label}} (conf: {{confidence}}%) | {{reasoning}}')

    try:
        for i, out in ordered_map(compute, range(start_index, total), workers, lambda: is_stopped(project_id)):
            emit_progress(socketio, block_id, i + 1, total, project_id)

            if out["kind"] == "error":
                emit_log(socketio, out["message"], "error", project_id)
                continue

            unit = out["unit"]
            if out["kind"] == "false":
                detection_conf = out["detection_conf"]
                # Write to false CSV with reasoning
                false_writer.writerow({
                    "id": f"{block_id}-{line_number}",
                    "unit_id": unit["unit_id"],
                    "doc_index": unit.get("doc_index", ""),
                    "filename": unit.get("filename", ""),
                    "false_confidence": detection_conf if not out["is_true"] else round(100 - detection_conf, 2),
                    "reasoning": out["reasoning"],
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                })
                emit_log(socketio, render_template(unit_log_template, {
                    "verdict": "SKIP",
                    "unitId": unit["unit_id"],
                    "snippet": out["snippet"],
                    "label": "",
                    "confidence": f"{detection_conf:.0f}",
                    "reasoning": out["reasoning"],
                }), "info", project_id)
                line_number += 1
                save_state(block_dir, {"completed_count": i + 1, "line_number": line_number})
                continue

            labels_writer.writerow({
                "line_number": line_number,
                "unit_id": unit["unit_id"],
                "doc_index": unit.get("doc_index", ""),
                "filename": unit.get("filename", ""),
                "detection_confidence": out["detection_conf"],
                "label": out["label"],
                "reasoning": out["reasoning"],
                "label_confidence": out["label_conf"],
                "timestamp": datetime.utcnow().isoformat() + "Z",
            })
            emit_log(socketio, render_template(unit_log_template, {
                "verdict": "LABEL",
                "unitId": unit["unit_id"],
                "snippet": out["snippet"],
                "label": out["label"],
                "confidence": f"{out['label_conf']:.0f}",
                "reasoning": out["reasoning"],
            }), "info", project_id)
            line_number += 1

            save_state(block_dir, {"completed_count": i + 1, "line_number": line_number})

    finally:
        labels_file.close()
        false_file.close()

    from services.version_control import commit_project
    commit_project(proj_dir, f"Block {block_id} source analysis complete")



# Private helpers now imported from services.llm_utils:
# _load_all_units, _build_context_for_unit, _open_csv,
# _extract_bool_confidence, _extract_label_confidence, _parse_label_response
