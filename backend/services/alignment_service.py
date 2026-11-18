"""Per-block alignment testing: sampling, human labeling, metrics, test management."""

import os
import json
import random
import secrets
from datetime import datetime, timezone

from config import PROJECTS_DIR, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_ALIGNMENT_SAMPLE_SIZE


ALIGNMENT_BLOCK_TYPES = ("sourceAnalysis", "rubricAnalysis", "themeIdent", "categoryBuild", "customPrompt")


def _comparison_mode(block_type):
    """How a block type is aligned: independent per-unit samples, a per-unit
    match against a frozen theme list (themeIdent), or a single whole-output
    comparison (categoryBuild/customPrompt — these run as one LLM call over
    aggregate input, not per text unit, so they can't be sampled per-unit).
    """
    if block_type in ("sourceAnalysis", "rubricAnalysis"):
        return "per_unit"
    if block_type == "themeIdent":
        return "per_unit_theme_match"
    return "single_output"


def _compute_step_numbers(flow):
    """1-based pipeline step number per analysis block, mirroring the canvas's
    own numbering exactly (FlowEditor.jsx's computeSequenceOrder): position of
    the block's id within flow["blockOrder"], counting only analysis-block
    types. A block missing from blockOrder (or not among the counted types)
    has no step number — same as the canvas's red "–" badge.
    """
    node_types = {n["id"]: n.get("type") for n in flow.get("nodes", [])}
    steps = {}
    seq = 1
    for block_id in flow.get("blockOrder", []):
        if node_types.get(block_id) in ALIGNMENT_BLOCK_TYPES:
            steps[block_id] = seq
            seq += 1
    return steps


def get_alignment_blocks(project_id):
    """Read flow.json and return all analysis-block types available for alignment testing."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow_path = os.path.join(proj_dir, "flow.json")
    if not os.path.exists(flow_path):
        return []

    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)

    step_numbers = _compute_step_numbers(flow)

    blocks = []
    for node in flow.get("nodes", []):
        ntype = node.get("type")
        if ntype not in ALIGNMENT_BLOCK_TYPES:
            continue
        data = node.get("data", {})
        block = {
            "block_id": node["id"],
            "block_type": ntype,
            "label": data.get("label", node["id"]),
            "source_type": data.get("source_type", "all"),
            "unit_type": data.get("unit_type", "sentence"),
            "comparison_mode": _comparison_mode(ntype),
            "step_number": step_numbers.get(node["id"]),
            "data": data,
        }
        if ntype == "sourceAnalysis":
            block["detection_prompt"] = data.get("detection_prompt", "")
            block["label_prompt"] = data.get("label_prompt", "")
            block["detection_threshold"] = data.get("detection_threshold", 70.0)
            block["label_threshold"] = data.get("label_threshold", 70.0)
        elif ntype == "rubricAnalysis":
            block["rubric_items"] = data.get("rubric_items", [])
            block["label_threshold"] = data.get("label_threshold", 70.0)
        elif ntype == "customPrompt":
            block["prompt"] = data.get("prompt", "")
        blocks.append(block)
    return blocks


def sampling_frame(project_id, block_id):
    """The pool of units an alignment sample is drawn from (exactly as the
    block's analysis would see them). Returns dict or {"error": ...}."""
    from services.llm_utils import load_all_units, resolve_doc_indices, resolve_split_delimiters

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_type, block_data = _get_block(project_id, block_id)
    if not block_data:
        return {"error": f"Block {block_id} not found in flow"}
    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project = json.load(f)

    doc_indices = resolve_doc_indices(proj_dir, block_data)
    unit_type = block_data.get("unit_type", project.get("unit_type", "sentence"))
    sentence_column = block_data.get("sentence_column")
    units = load_all_units(
        proj_dir, doc_indices=doc_indices, unit_type=unit_type, project_short=project["id"][:4],
        sentence_column=sentence_column,
        sentence_split_method=block_data.get("sentence_split_method", "sentence"),
        sentence_split_delimiters=resolve_split_delimiters(block_data),
    )
    excluded_blank = 0
    if sentence_column:
        # A blank target cell produces no R-type sub-units (see
        # unit_manager.apply_column_reparse) — load_all_units() keeps such a
        # row's original whole-row L-unit as a fallback so real analysis runs
        # never silently skip a row. For alignment sampling there's nothing
        # meaningful to show a human rater for an empty cell, so exclude
        # those rows from the sampling pool entirely rather than drawing a
        # blank case.
        def _has_cell_content(u):
            if u.get("unit_type") == "R":
                return bool((u.get("text") or "").strip())
            row_data = u.get("row_data") or {}
            val = row_data.get(sentence_column)
            return val is not None and str(val).strip() != ""
        before = len(units)
        units = [u for u in units if _has_cell_content(u)]
        excluded_blank = before - len(units)
    return {"units": units, "block_type": block_type, "block_data": block_data, "project": project,
            "unit_type": unit_type, "doc_indices": doc_indices, "excluded_blank": excluded_blank}


def generate_sample(project_id, block_id, sample_size=None):
    """Random sample N units from a block's configured data source.

    Persists the drawn sample immediately as a new draft test so it survives
    tab switches / block reselection without requiring an explicit save.
    """
    from services.llm_utils import (
        build_context_for_unit, group_sentences_by_paragraph,
        build_paragraph_context_for_unit, format_unit_content,
    )

    if sample_size is None:
        sample_size = DEFAULT_ALIGNMENT_SAMPLE_SIZE
    requested_sample_size = sample_size

    frame = sampling_frame(project_id, block_id)
    if "error" in frame:
        return frame
    units, block_type, block_data = frame["units"], frame["block_type"], frame["block_data"]
    unit_type = frame["unit_type"]

    if not units:
        return {"error": "No units available for sampling"}

    sample_size = min(sample_size, len(units))

    # Simple random sample without replacement. The seed is drawn fresh and
    # recorded so the exact draw can be reported and reproduced.
    sampling_seed = secrets.randbits(32)
    sampled_indices = random.Random(sampling_seed).sample(range(len(units)), sample_size)
    context_window = block_data.get("context_window", 0)
    context_mode = block_data.get("context_mode", "units")
    paragraph_groups = (
        group_sentences_by_paragraph(units)
        if context_mode == "paragraph" and (unit_type == "sentence" or block_data.get("sentence_column"))
        else None
    )

    selected_columns = block_data.get("selected_columns") or []

    sample_units = []
    for idx in sampled_indices:
        unit = units[idx]
        row_data = unit.get("row_data")
        is_spreadsheet = row_data is not None

        # Format text: use selected columns for spreadsheets, full text otherwise
        text = format_unit_content(unit, selected_columns) if is_spreadsheet else unit.get("text", "")

        # Context: paragraph/cell mode first (covers cell-split R-type units,
        # which also carry row_data and would otherwise hit the spreadsheet
        # skip below); skip for whole-row spreadsheets (independent cases);
        # include for text docs.
        if paragraph_groups is not None:
            cb, ca = build_paragraph_context_for_unit(unit, paragraph_groups)
        elif is_spreadsheet:
            cb, ca = "", ""
        elif context_window:
            cb, ca = build_context_for_unit(units, idx, int(context_window))
        else:
            cb = unit.get("context_before", "")
            ca = unit.get("context_after", "")

        sample_units.append({
            "unit_id": unit["unit_id"],
            "text": text,
            "context_before": cb,
            "context_after": ca,
        })

    sample_unit_ids = [u["unit_id"] for u in sample_units]

    # A new sample always replaces the current working draft — discard any
    # prior draft(s) for this block so the file list doesn't accumulate
    # abandoned samples. Completed/named tests are never touched here.
    for existing in list_tests(project_id, block_id):
        if existing.get("status") == "draft":
            delete_test(project_id, existing["test_id"])

    test_data = create_or_update_test(project_id, block_id, {
        "block_id": block_id,
        "block_type": block_type,
        "sample_units": sample_units,
        "sample_unit_ids": sample_unit_ids,
        "sample_size": sample_size,
        "requested_sample_size": requested_sample_size,
        "sampling": {
            "method": "simple random sample without replacement",
            "seed": sampling_seed,
            "frame_size": len(units),
            "excluded_blank_cells": frame["excluded_blank"],
            "drawn_at": datetime.now(timezone.utc).isoformat(),
        },
        "human_labels": {},
        "status": "draft",
    })
    if "error" in test_data:
        return test_data

    return {
        "sample_units": sample_units,
        "sample_unit_ids": sample_unit_ids,
        "total_available": len(units),
        "sample_size": sample_size,
        "requested_sample_size": requested_sample_size,
        "test_id": test_data["test_id"],
        "created_at": test_data.get("created_at"),
    }


def generate_theme_sample(project_id, block_id, sample_size=None):
    """Sample N rows for a themeIdent block, paired with its most recently
    established theme list (read from the block's last completed run).

    themeIdent normally runs as a sequential, order-dependent constant
    comparison (each row is compared against the theme list *as accumulated
    so far*), so independently-sampled rows can't faithfully replay that
    algorithm. This is a deliberate v1 approximation: it freezes the block's
    current theme list as fixed reference context and checks each sampled
    row against it, rather than the live sequential process.
    """
    import csv as csv_mod

    if sample_size is None:
        sample_size = DEFAULT_ALIGNMENT_SAMPLE_SIZE
    requested_sample_size = sample_size

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_type, block_data = _get_block(project_id, block_id)
    if not block_data:
        return {"error": f"Block {block_id} not found in flow"}

    block_dir = os.path.join(proj_dir, "blocks", block_id)
    themes_path = os.path.join(block_dir, f"{block_id}_themes.csv")
    if not os.path.exists(themes_path):
        return {"error": "This block has no completed run yet. Run it once to establish a theme list before aligning."}

    with open(themes_path, "r", encoding="utf-8", newline="") as f:
        themes = [
            {
                "theme_id": row.get("theme_id", ""),
                "theme_title": row.get("theme_title", ""),
                "description": row.get("description", ""),
            }
            for row in csv_mod.DictReader(f)
        ]

    input_block_ids = block_data.get("input_block_ids") or []
    if not input_block_ids and block_data.get("input_block_id"):
        input_block_ids = [block_data["input_block_id"]]

    rows = []
    for bid in input_block_ids:
        csv_path = os.path.join(proj_dir, "blocks", bid, f"{bid}_labels.csv")
        if not os.path.exists(csv_path):
            continue
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            rows.extend(list(csv_mod.DictReader(f)))

    if not rows:
        return {"error": "No upstream labeled rows available to sample from"}

    sample_size = min(sample_size, len(rows))
    sampling_seed = secrets.randbits(32)
    sampled_rows = random.Random(sampling_seed).sample(rows, sample_size)

    sample_units = []
    for i, row in enumerate(sampled_rows):
        label = row.get("label", "") or row.get("rubric_1_score", "")
        reasoning = row.get("reasoning", "") or row.get("rubric_1_justification", "")
        sample_units.append({
            "unit_id": row.get("unit_id") or f"row_{i}",
            "text": f"Label: {label}" + (f" — {reasoning}" if reasoning else ""),
            "label": label,
            "reasoning": reasoning,
            "context_before": "",
            "context_after": "",
        })

    sample_unit_ids = [u["unit_id"] for u in sample_units]

    for existing in list_tests(project_id, block_id):
        if existing.get("status") == "draft":
            delete_test(project_id, existing["test_id"])

    test_data = create_or_update_test(project_id, block_id, {
        "block_id": block_id,
        "block_type": block_type,
        "comparison_mode": "per_unit_theme_match",
        "theme_reference_list": themes,
        "sample_units": sample_units,
        "sample_unit_ids": sample_unit_ids,
        "sample_size": sample_size,
        "requested_sample_size": requested_sample_size,
        "sampling": {
            "method": "simple random sample without replacement (upstream labeled rows)",
            "seed": sampling_seed,
            "frame_size": len(rows),
            "drawn_at": datetime.now(timezone.utc).isoformat(),
        },
        "human_labels": {},
        "status": "draft",
    })
    if "error" in test_data:
        return test_data

    return {
        "sample_units": sample_units,
        "sample_unit_ids": sample_unit_ids,
        "theme_reference_list": themes,
        "total_available": len(rows),
        "sample_size": sample_size,
        "requested_sample_size": requested_sample_size,
        "test_id": test_data["test_id"],
        "created_at": test_data.get("created_at"),
    }


def get_single_output_context(project_id, block_id):
    """Return the context text a human should review to author their expected
    output for a single-call block (categoryBuild, customPrompt). These
    blocks run as one LLM call over aggregate input, so alignment here is a
    single expected-vs-actual comparison, not a per-unit sample.
    """
    import csv as csv_mod

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_type, block_data = _get_block(project_id, block_id)
    if not block_data:
        return {"error": f"Block {block_id} not found in flow"}

    if block_type == "categoryBuild":
        input_block = block_data.get("input_block_id", "")
        themes_path = os.path.join(proj_dir, "blocks", input_block, f"{input_block}_themes.csv") if input_block else ""
        if not themes_path or not os.path.exists(themes_path):
            return {"error": "The upstream theme identification block has no completed run yet. Run it first."}
        with open(themes_path, "r", encoding="utf-8", newline="") as f:
            themes = list(csv_mod.DictReader(f))
        context_text = "\n".join(
            f"- {t.get('theme_id', '')}: {t.get('theme_title', '')} - {t.get('description', '')}"
            for t in themes
        )
        return {"context_text": context_text, "block_type": block_type}

    if block_type == "customPrompt":
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
        if not input_text:
            return {"error": "No input data available yet. Connect and run an upstream block first."}
        return {"context_text": input_text, "block_type": block_type}

    return {"error": f"Single-output alignment is not supported for block type '{block_type}'"}


def generate_single_output_test(project_id, block_id):
    """Create (or replace) the current draft for a single_output block."""
    ctx = get_single_output_context(project_id, block_id)
    if "error" in ctx:
        return ctx

    for existing in list_tests(project_id, block_id):
        if existing.get("status") == "draft":
            delete_test(project_id, existing["test_id"])

    test_data = create_or_update_test(project_id, block_id, {
        "block_id": block_id,
        "block_type": ctx["block_type"],
        "comparison_mode": "single_output",
        "context_text": ctx["context_text"],
        "human_expected": "",
        "human_expected_rationale": "",
        "llm_output": None,
        "status": "draft",
    })
    if "error" in test_data:
        return test_data

    return {
        "context_text": ctx["context_text"],
        "test_id": test_data["test_id"],
        "created_at": test_data.get("created_at"),
    }


def create_or_update_test(project_id, block_id, test_data):
    """Create or update a test file."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    test_dir = os.path.join(proj_dir, "alignment", "tests", block_id)
    os.makedirs(test_dir, exist_ok=True)

    test_id = test_data.get("test_id")
    if not test_id:
        # Generate new test ID and filename
        hex_part = secrets.token_hex(4)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        test_id = f"t_{hex_part}"
        filename = f"test_{hex_part}_{timestamp}.json"
        test_data["test_id"] = test_id
        test_data["created_at"] = datetime.now(timezone.utc).isoformat()
        test_data["status"] = "draft"
    else:
        # Find existing file
        filename = _find_test_file(test_dir, test_id)
        if not filename:
            return {"error": f"Test {test_id} not found"}

    filepath = os.path.join(test_dir, filename)

    # If updating, merge with existing data
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            existing = json.load(f)
        existing.update(test_data)
        test_data = existing

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(test_data, f, indent=2)

    return test_data


def save_single_label(project_id, test_id, unit_id, label_data):
    """Save one unit's human label in a test file."""
    test_data = get_test(project_id, test_id)
    if not test_data or "error" in test_data:
        return {"error": f"Test {test_id} not found"}

    if "human_labels" not in test_data:
        test_data["human_labels"] = {}

    test_data["human_labels"][unit_id] = label_data

    block_id = test_data.get("block_id")
    if not block_id:
        return {"error": "Test has no block_id"}

    test_dir = os.path.join(PROJECTS_DIR, project_id, "alignment", "tests", block_id)
    filename = _find_test_file(test_dir, test_id)
    if not filename:
        return {"error": f"Test file for {test_id} not found"}

    filepath = os.path.join(test_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(test_data, f, indent=2)

    return {"status": "saved", "unit_id": unit_id}


def _write_test(project_id, test_data):
    block_id = test_data.get("block_id")
    test_dir = os.path.join(PROJECTS_DIR, project_id, "alignment", "tests", block_id or "")
    filename = _find_test_file(test_dir, test_data.get("test_id", "")) if block_id else None
    if not filename:
        return {"error": "Test file not found"}
    with open(os.path.join(test_dir, filename), "w", encoding="utf-8") as f:
        json.dump(test_data, f, indent=2)
    return {"status": "saved"}


def save_rationale(project_id, test_id, unit_id, rationale, rubric_key=None, post_hoc=True):
    """Add/replace a human rationale without touching the human's code.

    Rationales written from the optimizer's "Explain disagreements" view are
    written after the model's output was visible, so they are flagged post-hoc.
    """
    test_data = get_test(project_id, test_id)
    if "error" in test_data:
        return test_data
    label = (test_data.setdefault("human_labels", {})).get(unit_id)
    if not isinstance(label, dict):
        return {"error": "This case has no human code yet; code it before adding a rationale."}
    text = (rationale or "").strip()
    if rubric_key:
        rats = dict(label.get("rubric_rationales") or {})
        rats[rubric_key] = text
        label["rubric_rationales"] = rats
    else:
        label["rationale"] = text
    if post_hoc:
        label["rationale_post_hoc"] = True
    label["rationale_at"] = datetime.now(timezone.utc).isoformat()
    result = _write_test(project_id, test_data)
    if "error" in result:
        return result
    return {"status": "saved", "unit_id": unit_id, "label": label}


# ── Rater reliability (blind re-code → rater ceiling) ─────────────

RELIABILITY_FRACTION = 0.15


def start_reliability(project_id, test_id, seed=20260911):
    """Pick a seeded 15% (min 1) of human-coded cases for a blind re-code."""
    import random as _random
    test_data = get_test(project_id, test_id)
    if "error" in test_data:
        return test_data
    coded = sorted(u for u, l in (test_data.get("human_labels") or {}).items()
                   if isinstance(l, dict) and (l.get("detection") or l.get("rubric_scores")))
    if not coded:
        return {"error": "Code some cases first."}
    rel = test_data.get("reliability") or {}
    if not rel.get("recheck_ids"):
        rng = _random.Random(seed)
        k = max(1, round(len(coded) * RELIABILITY_FRACTION))
        ids = rng.sample(coded, k)
        rng.shuffle(ids)
        rel = {"recheck_ids": ids, "labels": {}, "started_at": datetime.now(timezone.utc).isoformat()}
        test_data["reliability"] = rel
        _write_test(project_id, test_data)
    units = {u["unit_id"]: u for u in test_data.get("sample_units", [])}
    # Earlier codes are deliberately NOT returned: the re-code must be blind.
    return {"recheck_ids": rel["recheck_ids"],
            "units": [units[u] for u in rel["recheck_ids"] if u in units],
            "labels": rel.get("labels", {}),
            "computed": rel.get("computed")}


def save_reliability_label(project_id, test_id, unit_id, label_data):
    test_data = get_test(project_id, test_id)
    if "error" in test_data:
        return test_data
    rel = test_data.get("reliability") or {}
    if unit_id not in (rel.get("recheck_ids") or []):
        return {"error": "That case is not part of the re-code set."}
    rel.setdefault("labels", {})[unit_id] = label_data
    test_data["reliability"] = rel
    return _write_test(project_id, test_data)


def compute_reliability(project_id, test_id):
    """Intra-rater agreement between first codes and the blind re-code."""
    from services.prompt_optimizer import scores_equal
    test_data = get_test(project_id, test_id)
    if "error" in test_data:
        return test_data
    rel = test_data.get("reliability") or {}
    first = test_data.get("human_labels") or {}
    agree = total = 0
    per_item = {}
    for uid, again in (rel.get("labels") or {}).items():
        orig = first.get(uid) or {}
        if test_data.get("block_type") == "rubricAnalysis":
            for k, v in (again.get("rubric_scores") or {}).items():
                ov = (orig.get("rubric_scores") or {}).get(k)
                if v in (None, "") or ov in (None, ""):
                    continue
                same = scores_equal(ov, v)
                agree += same
                total += 1
                pi = per_item.setdefault(k, [0, 0])
                pi[0] += same
                pi[1] += 1
        else:
            a, b = (orig.get("detection") or "").upper(), (again.get("detection") or "").upper()
            if a in ("TRUE", "FALSE") and b in ("TRUE", "FALSE"):
                agree += a == b
                total += 1
    if not total:
        return {"error": "No re-coded cases to compare yet."}
    rel["computed"] = {
        "n": total,
        "self_agreement": agree / total,
        "per_item": {k: v[0] / v[1] for k, v in per_item.items()} or None,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }
    test_data["reliability"] = rel
    _write_test(project_id, test_data)
    return rel["computed"]


def compute_detection_metrics(human_labels, llm_results):
    """Compute % alignment + Cohen's Kappa for detection (TRUE/FALSE)."""
    details = {}
    human_vals = []
    llm_vals = []

    for unit_id, h in human_labels.items():
        if unit_id not in llm_results:
            continue
        l = llm_results[unit_id]
        h_det = h.get("detection", "").upper()
        l_det = (l.get("detection") or "").upper()
        aligned = h_det == l_det
        details[unit_id] = {"human": h_det, "llm": l_det, "aligned": aligned}
        human_vals.append(h_det)
        llm_vals.append(l_det)

    n = len(human_vals)
    if n == 0:
        return {"percent_alignment": 0, "cohens_kappa": 0, "interpretation": "No data", "n": 0, "details": {}}

    aligned_count = sum(1 for d in details.values() if d["aligned"])
    pct = round((aligned_count / n) * 100, 1)
    kappa = _cohens_kappa(human_vals, llm_vals)

    return {
        "percent_alignment": pct,
        "cohens_kappa": round(kappa, 4),
        "interpretation": _interpret_kappa(kappa),
        "n": n,
        "details": details,
    }


def compute_label_similarity(human_labels, llm_results, threshold=None):
    """Compute per-unit label similarity via gensim."""
    from services.similarity import find_best_pairings

    if threshold is None:
        threshold = DEFAULT_SIMILARITY_THRESHOLD

    per_unit = {}
    total_sim = 0
    count = 0

    for unit_id, h in human_labels.items():
        if unit_id not in llm_results:
            continue
        h_labels = h.get("labels", [])
        l_labels = llm_results[unit_id].get("labels", [])

        if not h_labels and not l_labels:
            per_unit[unit_id] = {"pairings": [], "unmatched_human": [], "unmatched_llm": [], "unit_similarity": 100.0}
            total_sim += 100.0
            count += 1
            continue

        if not h_labels or not l_labels:
            per_unit[unit_id] = {"pairings": [], "unmatched_human": h_labels, "unmatched_llm": l_labels, "unit_similarity": 0.0}
            count += 1
            continue

        matched, unmatched_h, unmatched_l = find_best_pairings(h_labels, l_labels)

        # Unmatched get 0 similarity
        total_pairs = len(matched) + len(unmatched_h) + len(unmatched_l)
        if total_pairs > 0:
            unit_sim = sum(m["similarity"] for m in matched) / total_pairs
        else:
            unit_sim = 0.0

        per_unit[unit_id] = {
            "pairings": matched,
            "unmatched_human": unmatched_h,
            "unmatched_llm": unmatched_l,
            "unit_similarity": round(unit_sim, 1),
        }
        total_sim += unit_sim
        count += 1

    mean_sim = round(total_sim / count, 1) if count > 0 else 0
    return {"mean_similarity": mean_sim, "per_unit": per_unit}


def compute_rubric_metrics(human_labels, llm_results, rubric_items, match_mode="exact"):
    """Compute per-rubric % alignment + Kappa (both exact and weighted)."""
    metrics = {}

    for r_idx, item in enumerate(rubric_items):
        rubric_key = f"rubric_{r_idx + 1}"
        human_scores = []
        llm_scores = []

        for unit_id, h in human_labels.items():
            if unit_id not in llm_results:
                continue
            h_scores = h.get("rubric_scores") or {}
            l_scores = llm_results[unit_id].get("rubric_scores") or {}
            h_val = h_scores.get(rubric_key)
            l_val = l_scores.get(rubric_key)
            if h_val is not None and l_val is not None:
                human_scores.append(str(h_val))
                llm_scores.append(str(l_val))

        n = len(human_scores)
        if n == 0:
            metrics[rubric_key] = {
                "title": item.get("title", rubric_key),
                "percent_alignment": 0, "cohens_kappa": 0,
                "weighted_percent": 0, "weighted_kappa": 0,
                "interpretation": "No data",
            }
            continue

        # Exact alignment
        exact_aligned = sum(1 for h, l in zip(human_scores, llm_scores) if h == l)
        exact_pct = round((exact_aligned / n) * 100, 1)
        exact_kappa = _cohens_kappa(human_scores, llm_scores)

        # Weighted alignment (within 1 point)
        weighted_aligned = 0
        for h, l in zip(human_scores, llm_scores):
            try:
                if abs(float(h) - float(l)) <= 1:
                    weighted_aligned += 1
            except ValueError:
                if h == l:
                    weighted_aligned += 1
        weighted_pct = round((weighted_aligned / n) * 100, 1)
        weighted_kappa = _weighted_kappa(human_scores, llm_scores)

        metrics[rubric_key] = {
            "title": item.get("title", rubric_key),
            "percent_alignment": exact_pct,
            "cohens_kappa": round(exact_kappa, 4),
            "weighted_percent": weighted_pct,
            "weighted_kappa": round(weighted_kappa, 4),
            "interpretation": _interpret_kappa(exact_kappa if match_mode == "exact" else weighted_kappa),
        }

    return metrics


def compute_theme_match_metrics(human_labels, llm_results):
    """Basic agreement metric for per_unit_theme_match: did the human's chosen
    theme (or 'NEW') match the LLM's, against the same frozen theme list?
    """
    details = {}
    matches = 0
    n = 0
    for unit_id, h in human_labels.items():
        if unit_id not in llm_results:
            continue
        h_choice = (h.get("theme_choice") or "").strip()
        l_choice = (llm_results[unit_id].get("theme_choice") or "").strip()
        aligned = bool(h_choice) and h_choice == l_choice
        details[unit_id] = {"human": h_choice, "llm": l_choice, "aligned": aligned}
        matches += 1 if aligned else 0
        n += 1

    if n == 0:
        return {"percent_alignment": 0, "n": 0, "details": {}}

    return {"percent_alignment": round((matches / n) * 100, 1), "n": n, "details": details}


def compute_overall_score(metrics):
    """Compute weighted average overall score from metrics dict."""
    scores = []

    detection = metrics.get("detection")
    if detection and detection.get("n", 0) > 0:
        scores.append(detection["percent_alignment"])

    labels = metrics.get("labels")
    if labels and labels.get("mean_similarity", 0) > 0:
        scores.append(labels["mean_similarity"])

    rubric = metrics.get("rubric_scores")
    if rubric:
        for rk, rv in rubric.items():
            if rv.get("percent_alignment", 0) > 0:
                scores.append(rv["percent_alignment"])

    theme_match = metrics.get("theme_match")
    if theme_match and theme_match.get("n", 0) > 0:
        scores.append(theme_match["percent_alignment"])

    single_output = metrics.get("single_output")
    if single_output and single_output.get("similarity") is not None:
        scores.append(single_output["similarity"])

    return round(sum(scores) / len(scores), 1) if scores else 0.0


def list_tests(project_id, block_id):
    """List all test files for a block with summary data, newest first."""
    test_dir = os.path.join(PROJECTS_DIR, project_id, "alignment", "tests", block_id)
    if not os.path.exists(test_dir):
        return []

    tests = []
    for fname in os.listdir(test_dir):
        if not fname.endswith(".json"):
            continue
        filepath = os.path.join(test_dir, fname)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            tests.append({
                "test_id": data.get("test_id"),
                "created_at": data.get("created_at"),
                "status": data.get("status", "unknown"),
                "sample_size": data.get("sample_size", 0),
                "block_type": data.get("block_type"),
                "metrics": {
                    "detection": data.get("metrics", {}).get("detection", {}).get("percent_alignment"),
                    "cohens_kappa": data.get("metrics", {}).get("detection", {}).get("cohens_kappa"),
                    "label_similarity": data.get("metrics", {}).get("labels", {}).get("mean_similarity"),
                    "overall_score": data.get("metrics", {}).get("overall_score"),
                },
                "filename": fname,
            })
        except (json.JSONDecodeError, OSError):
            continue

    # created_at is ISO 8601 so lexicographic sort == chronological sort.
    # (filename order is NOT reliable here — the random hex id precedes the
    # timestamp in the filename, so sorting filenames doesn't sort by time.)
    tests.sort(key=lambda t: t.get("created_at") or "", reverse=True)
    return tests


def get_current_draft(project_id, block_id):
    """Return the most recently created status=='draft' test for a block, or None."""
    for summary in list_tests(project_id, block_id):
        if summary.get("status") == "draft":
            full = get_test(project_id, summary["test_id"])
            if "error" not in full:
                return full
    return None


def get_test(project_id, test_id):
    """Load full test data by scanning all block directories."""
    tests_root = os.path.join(PROJECTS_DIR, project_id, "alignment", "tests")
    if not os.path.exists(tests_root):
        return {"error": "No tests found"}

    for block_dir_name in os.listdir(tests_root):
        block_dir = os.path.join(tests_root, block_dir_name)
        if not os.path.isdir(block_dir):
            continue
        filename = _find_test_file(block_dir, test_id)
        if filename:
            filepath = os.path.join(block_dir, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)

    return {"error": f"Test {test_id} not found"}


def delete_test(project_id, test_id):
    """Delete a test file."""
    tests_root = os.path.join(PROJECTS_DIR, project_id, "alignment", "tests")
    if not os.path.exists(tests_root):
        return {"error": "No tests found"}

    for block_dir_name in os.listdir(tests_root):
        block_dir = os.path.join(tests_root, block_dir_name)
        if not os.path.isdir(block_dir):
            continue
        filename = _find_test_file(block_dir, test_id)
        if filename:
            os.remove(os.path.join(block_dir, filename))
            return {"status": "deleted", "test_id": test_id}

    return {"error": f"Test {test_id} not found"}


def update_block_prompts(project_id, block_id, prompts):
    """Write prompt changes directly to flow.json node.data."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow_path = os.path.join(proj_dir, "flow.json")

    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)

    updated = False
    for node in flow.get("nodes", []):
        if node["id"] == block_id:
            data = node.setdefault("data", {})
            for key, val in prompts.items():
                data[key] = val
            updated = True
            break

    if not updated:
        return {"error": f"Block {block_id} not found in flow"}

    with open(flow_path, "w", encoding="utf-8") as f:
        json.dump(flow, f, indent=2)

    return {"status": "updated", "block_id": block_id}


# ── Internal helpers ──────────────────────────────────────────────

def _get_block(project_id, block_id):
    """Get (node_type, data) for a block from flow.json."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    flow_path = os.path.join(proj_dir, "flow.json")
    if not os.path.exists(flow_path):
        return None, None
    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)
    for node in flow.get("nodes", []):
        if node["id"] == block_id:
            # Fill input_block_id(s) from the flow's connections so alignment
            # uses the same inputs as an analysis run.
            from models.flow_graph import FlowGraph
            graph = FlowGraph(proj_dir)
            graph._data = flow
            return node.get("type"), graph.apply_resolved_inputs(block_id, node.get("data", {}))
    return None, None


def _find_test_file(test_dir, test_id):
    """Find test filename by test_id prefix."""
    # test_id format: t_<8hex>
    hex_part = test_id.replace("t_", "")
    for fname in os.listdir(test_dir):
        if fname.startswith(f"test_{hex_part}") and fname.endswith(".json"):
            return fname
    return None


def _cohens_kappa(rater1, rater2):
    """Compute Cohen's Kappa for two raters."""
    n = len(rater1)
    if n == 0:
        return 0.0

    def _ordinal_key(v):
        # Numeric-aware ordering so "10" sorts after "2" (scores are stored as strings)
        try:
            return (0, float(v), "")
        except (TypeError, ValueError):
            return (1, 0.0, str(v))

    labels = sorted(set(rater1) | set(rater2), key=_ordinal_key)
    label_to_idx = {l: i for i, l in enumerate(labels)}
    k = len(labels)

    matrix = [[0] * k for _ in range(k)]
    for a, b in zip(rater1, rater2):
        matrix[label_to_idx[a]][label_to_idx[b]] += 1

    p_o = sum(matrix[i][i] for i in range(k)) / n

    p_e = 0
    for i in range(k):
        row_sum = sum(matrix[i])
        col_sum = sum(matrix[j][i] for j in range(k))
        p_e += (row_sum * col_sum)
    p_e /= (n * n)

    if p_e == 1.0:
        return 1.0 if p_o == 1.0 else 0.0

    return (p_o - p_e) / (1 - p_e)


def _weighted_kappa(rater1, rater2):
    """Compute linearly weighted Cohen's Kappa for ordinal data."""
    n = len(rater1)
    if n == 0:
        return 0.0

    labels = sorted(set(rater1) | set(rater2))
    label_to_idx = {l: i for i, l in enumerate(labels)}
    k = len(labels)
    if k <= 1:
        return 1.0

    matrix = [[0] * k for _ in range(k)]
    for a, b in zip(rater1, rater2):
        matrix[label_to_idx[a]][label_to_idx[b]] += 1

    # Linear weights: w_ij = 1 - |i-j| / (k-1)
    weights = [[1.0 - abs(i - j) / (k - 1) for j in range(k)] for i in range(k)]

    p_o = sum(weights[i][j] * matrix[i][j] for i in range(k) for j in range(k)) / n

    row_sums = [sum(matrix[i]) for i in range(k)]
    col_sums = [sum(matrix[j][i] for j in range(k)) for i in range(k)]
    p_e = sum(weights[i][j] * row_sums[i] * col_sums[j] for i in range(k) for j in range(k)) / (n * n)

    if p_e == 1.0:
        return 1.0 if p_o == 1.0 else 0.0

    return (p_o - p_e) / (1 - p_e)


def _interpret_kappa(kappa):
    if kappa < 0:
        return "Poor (less than chance)"
    elif kappa < 0.21:
        return "Slight agreement"
    elif kappa < 0.41:
        return "Fair agreement"
    elif kappa < 0.61:
        return "Moderate agreement"
    elif kappa < 0.81:
        return "Substantial agreement"
    else:
        return "Almost perfect agreement"
