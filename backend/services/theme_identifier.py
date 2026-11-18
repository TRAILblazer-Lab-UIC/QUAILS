"""Block Type 2: Theme identification via constant comparison."""

import os
import csv
import json
from datetime import datetime

from config import PROJECTS_DIR, OLLAMA_BASE_URL, SELECTED_MODEL


def run_theme_identification(project_id, block_id, block_data, model_params=None):
    """Execute theme identification (Block Type 2).

    For each label row from input CSV:
    1. Load label + rationale
    2. Compare against existing themes
    3. Assign to existing theme or create new one
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

    # Support multiple upstream blocks (input_block_ids) with legacy fallback (input_block_id)
    input_block_ids = block_data.get("input_block_ids") or []
    if not input_block_ids and block_data.get("input_block_id"):
        input_block_ids = [block_data["input_block_id"]]

    # Also support explicit input_csv path (legacy)
    explicit_csv = block_data.get("input_csv", "")
    if explicit_csv and os.path.exists(explicit_csv):
        rows, input_fieldnames = _load_csv(explicit_csv)
    else:
        all_rows = []
        all_fieldnames = []
        for bid in input_block_ids:
            csv_path = os.path.join(proj_dir, "blocks", bid, f"{bid}_labels.csv")
            if not os.path.exists(csv_path):
                emit_log(socketio, f"Labels CSV not found for upstream block {bid} — skipping", "warning", project_id)
                continue
            r, fn = _load_csv(csv_path)
            all_rows.extend(r)
            for field in (fn or []):
                if field not in all_fieldnames:
                    all_fieldnames.append(field)
            emit_log(socketio, f"Loaded {len(r)} rows from block {bid}", "info", project_id)
        if not all_rows:
            from services.pipeline import BlockFailed
            if not input_block_ids:
                raise BlockFailed("No input connected. Connect an Open-Coding or Rubric block to Theme Identification.")
            raise BlockFailed("No coded units found from " + ", ".join(input_block_ids)
                              + ". Run the connected block first.")
        rows = all_rows
        input_fieldnames = all_fieldnames

    total = len(rows)
    state = load_state(block_dir)
    start_index = state.get("completed_count", 0)

    theme_threshold = block_data.get("theme_threshold",
        project.get("thresholds", {}).get("theme", 80.0))

    # Load prompt templates
    templates = get_effective_templates(project_id)
    ti = templates.get("themeIdent", {})
    comp_t = ti.get("themeComparison", {})
    title_t = ti.get("titleGeneration", {})

    # Themes CSV
    themes_path = os.path.join(block_dir, f"{block_id}_themes.csv")
    themes = _load_themes(themes_path)
    next_theme_id = len(themes) + 1

    # Revised labels CSV (copy of input + theme_id column)
    revised_path = os.path.join(block_dir, f"revised{block_id}labels.csv")
    revised_fieldnames = list(input_fieldnames or []) + ["theme_id", "timestamp"]

    revised_file = open(revised_path, "a" if start_index > 0 else "w", newline="", encoding="utf-8")
    revised_writer = csv.DictWriter(revised_file, fieldnames=revised_fieldnames, restval='', extrasaction='ignore')
    if start_index == 0:
        revised_writer.writeheader()

    workers = _analysis_workers(project)
    _write_run_environment(block_dir, client, workers)
    client.warm_model()
    if workers > 1:
        emit_log(socketio, f"⚠ Parallel analysis: up to {workers} theme comparisons per row at once — outputs are not "
                           "guaranteed byte-for-byte replicable against a sequential run.", "warning", project_id)

    try:
        for i in range(start_index, total):
            if is_stopped(project_id):
                break

            row = rows[i]
            emit_progress(socketio, block_id, i + 1, total, project_id)

            label, reasoning = _extract_label_reasoning(row)

            if not themes:
                # First label → create first theme
                theme_title = _generate_theme_title(client, label, reasoning, title_t)
                theme = {
                    "theme_id": f"T{next_theme_id:03d}",
                    "theme_title": theme_title,
                    "description": reasoning[:160],
                    "comparison_result": "NEW",
                    "confidence": 100.0,
                    "rationale": "First theme created",
                }
                themes.append(theme)
                next_theme_id += 1
                assigned_theme = theme["theme_id"]
            else:
                # Compare against existing themes
                best_theme = None
                best_conf = 0

                def compare(theme):
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
                            "themeTitle": theme["theme_title"],
                            "themeDescription": theme.get("description", ""),
                        },
                    )
                    messages = [
                        {"role": "system", "content": comp_system},
                        {"role": "user", "content": comp_user},
                    ]
                    return client.chat(messages, temperature=0.1, num_predict=5, logprobs=True)

                # Rows stay strictly sequential (the theme list grows row by row); only this
                # row's comparisons may run in parallel, and only if the user enabled it.
                # Results are consumed in theme order, so tie-breaking is unchanged.
                for theme, result in ordered_map(compare, list(themes), workers):
                    if result.get("error"):
                        continue

                    response = (result.get("content") or "").strip().upper()
                    if "TRUE" in response:
                        conf = _extract_conf(result.get("logprobs", []))
                        if conf > best_conf:
                            best_conf = conf
                            best_theme = theme

                if best_theme and best_conf >= theme_threshold:
                    assigned_theme = best_theme["theme_id"]
                else:
                    # Create new theme
                    theme_title = _generate_theme_title(client, label, reasoning, title_t)
                    theme = {
                        "theme_id": f"T{next_theme_id:03d}",
                        "theme_title": theme_title,
                        "description": reasoning[:160],
                        "comparison_result": "NEW",
                        "confidence": 100.0,
                        "rationale": f"No existing theme matched above {theme_threshold}%",
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    }
                    themes.append(theme)
                    next_theme_id += 1
                    assigned_theme = theme["theme_id"]

            # Write revised label
            revised_row = dict(row)
            revised_row["theme_id"] = assigned_theme
            revised_row["timestamp"] = datetime.utcnow().isoformat() + "Z"
            revised_writer.writerow(revised_row)

            # Save themes
            _save_themes(themes_path, themes)
            save_state(block_dir, {"completed_count": i + 1})

            # Per-unit console log
            assigned_theme_obj = next((t for t in themes if t["theme_id"] == assigned_theme), {})
            unit_log = render_template(
                ti.get("consoleUnit", "[THEME] row {{rowNum}} → {{themeId}}: {{themeTitle}}"),
                {
                    "rowNum": i + 1,
                    "themeId": assigned_theme,
                    "themeTitle": assigned_theme_obj.get("theme_title", ""),
                },
            )
            emit_log(socketio, unit_log, "info", project_id)

    finally:
        revised_file.close()

    from services.version_control import commit_project
    commit_project(proj_dir, f"Block {block_id} theme identification complete")


def _extract_label_reasoning(row):
    """Extract label and reasoning from a row.

    Supports both sourceAnalysis output (label, reasoning columns) and
    rubricAnalysis output (rubric_N_score, rubric_N_justification columns).
    """
    if row.get("label"):
        return row["label"], row.get("reasoning", "")

    # rubricAnalysis output: rubric_N_score, rubric_N_justification
    labels = []
    justifications = []
    n = 1
    while True:
        score_key = f"rubric_{n}_score"
        just_key = f"rubric_{n}_justification"
        if score_key not in row and just_key not in row:
            break
        score = (row.get(score_key) or "").strip()
        just = (row.get(just_key) or "").strip()
        if score:
            labels.append(f"Rubric {n}: {score}")
        if just:
            justifications.append(just)
        n += 1

    combined_label = "; ".join(labels) if labels else ""
    combined_reasoning = " ".join(justifications) if justifications else ""
    return combined_label, combined_reasoning


def _load_csv(path):
    """Load a CSV file and return (rows, fieldnames)."""
    rows = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames) if reader.fieldnames else []
        for row in reader:
            rows.append(row)
    return rows, fieldnames


def _load_themes(path):
    if not os.path.exists(path):
        return []
    themes = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            themes.append(row)
    return themes


def _save_themes(path, themes):
    if not themes:
        return
    fieldnames = ["theme_id", "theme_title", "description", "comparison_result", "confidence", "rationale", "timestamp"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(themes)


def _generate_theme_title(client, label, reasoning, title_t=None):
    from services.prompt_template_service import render_template
    title_t = title_t or {}
    system_content = title_t.get(
        "systemTemplate",
        "Generate a 1-2 word theme title for this label. Respond with only the theme title.",
    )
    user_content = render_template(
        title_t.get("userTemplate", "Label: {{label}}\nRationale: {{reasoning}}"),
        {"label": label, "reasoning": reasoning},
    )
    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content},
    ]
    result = client.chat(messages, temperature=0.3, num_predict=10)
    return (result.get("content") or label)[:50].strip()


def _extract_conf(logprobs):
    if not logprobs:
        return 50.0
    from services.confidence_scorer import logprob_to_confidence
    first = logprobs[0] if logprobs else None
    if isinstance(first, (int, float)):
        return logprob_to_confidence(first)
    if isinstance(first, dict):
        return logprob_to_confidence(first.get("logprob", 0))
    return 50.0
