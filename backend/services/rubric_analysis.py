"""Block Type: Rubric-Based Analysis — single-pass scoring for every unit."""

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
    extract_label_confidence as _extract_label_confidence,
    parse_label_response as _parse_label_response,
    resolve_doc_indices,
    resolve_split_delimiters,
)


def run_rubric_analysis(project_id, block_id, block_data, model_params=None):
    """Execute rubric-based analysis.

    Scores every text unit against every rubric item in a single LLM call per item.
    No detection step — all units are always scored.
    Produces one CSV: {block_id}_labels.csv
      line_number, unit_id,
      rubric_1_score, rubric_1_confidence, rubric_1_justification,
      rubric_2_score, rubric_2_confidence, rubric_2_justification, ...

    rubric_N_score is blank when confidence < label_threshold; confidence and
    justification are always recorded.
    """
    from services.ollama_client import OllamaClient
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

    # Load all units
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
    line_number = state.get("line_number", start_index)

    rubric_items = block_data.get("rubric_items", [])
    if not rubric_items:
        emit_log(socketio, f"Block {block_id}: no rubric_items configured, skipping.", "warn", project_id)
        return

    label_threshold = block_data.get("label_threshold",
        project.get("thresholds", {}).get("label", 70.0))

    # Load prompt templates
    templates = get_effective_templates(project_id)
    ra = templates.get("rubricAnalysis", {})
    scoring_t = ra.get("scoring", {})

    # Emit console header
    header_template = ra.get("consoleHeader", "")
    header_vars = {
        "model": client.model,
        "numCtx": f"{client.num_ctx:,}" if client.num_ctx else "default (2,048)",
        "temperature": client.temperature,
        "seed": client.seed,
        "topK": client.top_k,
        "topP": client.top_p,
        "repeatPenalty": client.repeat_penalty,
        "unitType": unit_type,
        "rubricCount": len(rubric_items),
        "labelThreshold": label_threshold,
        "totalUnits": total,
        "startIndex": start_index,
    }
    if header_template:
        for line in render_template(header_template, header_vars).splitlines():
            emit_log(socketio, line, "info", project_id)
    else:
        ctx_display = f"{client.num_ctx:,} tokens" if client.num_ctx else "default (2,048 tokens)"
        emit_log(socketio, f"── Rubric Analysis ───────────────────────────────", "info", project_id)
        emit_log(socketio, f"Model: {client.model} | Context window: {ctx_display}", "info", project_id)
        emit_log(socketio, f"temperature={client.temperature} | seed={client.seed} | top_k={client.top_k} | top_p={client.top_p} | repeat_penalty={client.repeat_penalty}", "info", project_id)
        emit_log(socketio, f"Unit type: {unit_type} | Rubric items: {len(rubric_items)} | Label threshold: {label_threshold}%", "info", project_id)
        emit_log(socketio, f"Total units: {total} | Starting at: {start_index}", "info", project_id)
        emit_log(socketio, f"─────────────────────────────────────────────────", "info", project_id)
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

    # Build dynamic column names from rubric item count
    n_items = len(rubric_items)
    labels_fieldnames = ["line_number", "unit_id", "doc_index", "filename"]
    for n in range(1, n_items + 1):
        labels_fieldnames += [
            f"rubric_{n}_score",
            f"rubric_{n}_confidence",
            f"rubric_{n}_justification",
        ]
    labels_fieldnames.append("timestamp")

    # Open single output CSV
    write_header = start_index == 0
    labels_path = os.path.join(block_dir, f"{block_id}_labels.csv")
    labels_file, labels_writer = _open_csv(labels_path, write_header, labels_fieldnames)

    # Opt-in parallel analysis (project setting, off by default) — see source_analysis.py.
    workers = _analysis_workers(project)
    _write_run_environment(block_dir, client, workers)
    client.warm_model()
    if workers > 1:
        emit_log(socketio, f"⚠ Parallel analysis: {workers} units in flight at once — outputs are not guaranteed "
                           "byte-for-byte replicable against a sequential run.", "warning", project_id)

    def compute(i):
        """All LLM calls for unit i (rows are written in unit order below)."""
        unit = units[i]
        logs = []

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
            scoring_t.get("unitIntro", ""),
            {"unitType": unit_type},
        )

        # Build context framing
        pre_ctx_text = ""
        if cb:
            pre_ctx_text = render_template(
                scoring_t.get("contextPreTemplate", "[Context before: {{preContext}}]\n"),
                {"preContext": cb},
            ).strip()

        post_ctx_text = ""
        if ca:
            post_ctx_text = render_template(
                scoring_t.get("contextPostTemplate", "\n[Context after: {{postContext}}]"),
                {"postContext": ca},
            ).strip()

        user_content = "\n".join(filter(None, [
            unit_intro,
            unit_text,
            pre_ctx_text,
            post_ctx_text,
        ])).strip()

        row = {
            "unit_id": unit["unit_id"],
            "doc_index": unit.get("doc_index", ""),
            "filename": unit.get("filename", ""),
        }

        for n_idx, item in enumerate(rubric_items):
            n = n_idx + 1

            # Build system message from template
            system_content = render_template(
                scoring_t.get("systemTemplate", "Rubric item: {{rubricTitle}}\n\nDescription: {{rubricDescription}}\n\n{{blockPrompt}}"),
                {
                    "rubricTitle": item.get("title", ""),
                    "rubricDescription": item.get("description", ""),
                    "blockPrompt": item.get("scoring_prompt", ""),
                },
            )

            # Fresh messages list for every rubric item of every unit — no history from prior units
            messages = [
                {"role": "system", "content": system_content},
                {"role": "user", "content": user_content},
            ]
            result = client.chat(messages, temperature=0.1, num_predict=50, logprobs=True)
            if result.get("error"):
                logs.append((f"LLM error on {unit['unit_id']} rubric {n}: {result['error']}", "error"))
                row[f"rubric_{n}_score"] = ""
                row[f"rubric_{n}_confidence"] = ""
                row[f"rubric_{n}_justification"] = ""
                continue

            score_text, _ = _parse_label_response(result["content"].strip())
            label_conf = _extract_label_confidence(result.get("logprobs", []))

            # Reasoning follow-up
            reasoning_prompt_template = scoring_t.get(
                "reasoningPrompt",
                "Provide your reasoning for this score in fewer than {{reasoningWords}} words.",
            )
            reasoning_words = scoring_t.get("reasoningWords", 20)
            reasoning_prompt = render_template(
                reasoning_prompt_template, {"reasoningWords": reasoning_words}
            )
            messages_with_score = messages + [
                {"role": "assistant", "content": result["content"].strip()},
                {"role": "user", "content": reasoning_prompt},
            ]
            reasoning_result = client.chat(messages_with_score, temperature=0.1, num_predict=100)
            justification = (reasoning_result.get("content") or "").strip()

            row[f"rubric_{n}_score"] = score_text if label_conf >= label_threshold else ""
            row[f"rubric_{n}_confidence"] = label_conf
            row[f"rubric_{n}_justification"] = justification[:200]

            unit_log = render_template(
                ra.get("consoleUnit", "[RUBRIC] {{unitId}} — rubric_{{rubricIndex}}: {{score}} (conf: {{confidence}}%) | {{justification}}"),
                {
                    "unitId": unit["unit_id"],
                    "rubricIndex": n,
                    "score": score_text if label_conf >= label_threshold else "—",
                    "confidence": f"{label_conf:.0f}",
                    "justification": justification[:80],
                },
            )
            logs.append((unit_log, "info"))

        return row, logs

    try:
        for i, (row, logs) in ordered_map(compute, range(start_index, total), workers, lambda: is_stopped(project_id)):
            emit_progress(socketio, block_id, i + 1, total, project_id)
            for msg, level in logs:
                emit_log(socketio, msg, level, project_id)
            row["line_number"] = line_number
            row["timestamp"] = datetime.utcnow().isoformat() + "Z"
            labels_writer.writerow(row)
            line_number += 1
            save_state(block_dir, {"completed_count": i + 1, "line_number": line_number})

    finally:
        labels_file.close()

    from services.version_control import commit_project
    commit_project(proj_dir, f"Block {block_id} rubric analysis complete")



# Private helpers now imported from services.llm_utils:
# _load_all_units, _build_context_for_unit, _open_csv,
# _extract_label_confidence, _parse_label_response
