"""Shared LLM interaction utilities for open-coding and rubric-based analysis."""

import os
import csv
import json


def _substitute_sentence_units(raw_units, column_name):
    """Replace each L-type row unit with its R-type sentence sub-units for `column_name`.

    The parent row's row_data is denormalized onto each substitute unit
    in-memory only (never written back to disk) so the row's other
    whole-cell columns remain available as context via format_unit_content().
    Rows whose target cell was empty (no sub-units were generated) keep
    their original L-type unit as a fallback so no row is silently dropped.
    """
    by_parent = {}
    for u in raw_units:
        if u.get("unit_type") == "R" and u.get("column_name") == column_name:
            by_parent.setdefault(u["parent_unit_id"], []).append(u)
    for subs in by_parent.values():
        subs.sort(key=lambda u: u.get("sent_index") or 0)

    result = []
    for u in raw_units:
        if u.get("unit_type") == "R":
            continue
        if u.get("unit_type") == "L" and u["unit_id"] in by_parent:
            row_data = u.get("row_data")
            result.extend({**sub, "row_data": row_data} for sub in by_parent[u["unit_id"]])
        else:
            result.append(u)
    return result


def resolve_split_delimiters(block_data):
    """Read sentence_split_delimiters (list) from block_data.

    Falls back to the legacy single sentence_split_delimiter string saved by
    blocks configured before multi-delimiter support was added.
    """
    delimiters = block_data.get("sentence_split_delimiters")
    if delimiters:
        return delimiters
    legacy = block_data.get("sentence_split_delimiter")
    return [legacy] if legacy else None


def load_all_units(proj_dir, doc_indices=None, unit_type=None, project_short=None,
                    sentence_column=None, sentence_split_method="sentence", sentence_split_delimiters=None):
    """Load units from parsed documents. Re-segments from corpus if unit_type differs from stored.

    H-type (header) units are excluded unless project.include_headers is True.

    If `sentence_column` is given, that column's cells are (auto-persisting
    on first use) split into R-type sentence sub-units via
    unit_manager.reparse_column(), and each row's L-type unit is replaced by
    its sentence sub-units in the returned list — see _substitute_sentence_units.
    """
    # Load project config for include_headers flag
    include_headers = False
    project_path = os.path.join(proj_dir, "project.json")
    if os.path.exists(project_path):
        with open(project_path, "r", encoding="utf-8") as _pf:
            include_headers = json.load(_pf).get("include_headers", False)

    parsed_dir = os.path.join(proj_dir, "parsed")
    corpus_dir = os.path.join(proj_dir, "corpus")
    units = []
    if not os.path.exists(parsed_dir):
        return units
    for fname in sorted(os.listdir(parsed_dir)):
        if not fname.endswith(".json"):
            continue
        try:
            idx = int(fname.replace("doc_", "").replace(".json", ""))
        except ValueError:
            continue
        if doc_indices is not None and idx not in doc_indices:
            continue
        with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f:
            doc_json = json.load(f)

        stored_unit_type = doc_json.get("unit_type", "sentence")
        doc_filename = doc_json.get("filename", "")

        if unit_type and unit_type != stored_unit_type and project_short:
            corpus_path = os.path.join(corpus_dir, doc_filename)
            if doc_filename and os.path.exists(corpus_path):
                from services.document_parser import parse_document
                from services.unit_manager import build_units as _build_units
                parsed = parse_document(corpus_path)
                if parsed:
                    doc_index = doc_json.get("doc_index", idx)
                    new_units = _build_units(parsed, project_short, doc_index, unit_type)
                    new_dicts = [u.to_dict() for u in new_units]
                    if not include_headers:
                        new_dicts = [u for u in new_dicts if u.get("unit_type") != "H"]
                    units.extend([{**u, "filename": doc_filename} for u in new_dicts])
                    continue

        # Enrich each unit dict with filename; filter H units unless include_headers
        raw_units = doc_json.get("units", [])
        if not include_headers:
            raw_units = [u for u in raw_units if u.get("unit_type") != "H"]

        if (sentence_column and project_short
                and doc_json.get("format") in ("csv", "xlsx", "xls", "numbers")
                and sentence_column in (doc_json.get("columns") or [])):
            if not (doc_json.get("column_granularity") or {}).get(sentence_column):
                from services.unit_manager import reparse_column
                doc_index = doc_json.get("doc_index", idx)
                reparse_column(proj_dir, project_short, doc_index, sentence_column,
                                method=sentence_split_method, delimiters=sentence_split_delimiters)
                with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f2:
                    doc_json = json.load(f2)
                raw_units = doc_json.get("units", [])
                if not include_headers:
                    raw_units = [u for u in raw_units if u.get("unit_type") != "H"]
            raw_units = _substitute_sentence_units(raw_units, sentence_column)

        units.extend([{**u, "filename": doc_filename} for u in raw_units])
    return units


def build_context_for_unit(units, idx, context_window):
    """Build context_before / context_after strings from neighboring units at runtime.

    Neighbors are scoped to the same document by comparing the first two
    dash-separated segments of unit_id (project_short + doc_index).
    """
    if context_window == 0:
        return "", ""
    current_id = units[idx].get("unit_id", "")
    doc_prefix = "-".join(current_id.split("-")[:2])

    before_texts = []
    for j in range(max(0, idx - context_window), idx):
        u = units[j]
        if "-".join(u.get("unit_id", "").split("-")[:2]) == doc_prefix:
            before_texts.append(u.get("text", ""))

    after_texts = []
    for j in range(idx + 1, min(len(units), idx + context_window + 1)):
        u = units[j]
        if "-".join(u.get("unit_id", "").split("-")[:2]) == doc_prefix:
            after_texts.append(u.get("text", ""))

    return " ".join(before_texts), " ".join(after_texts)


def _paragraph_group_key(u):
    """Grouping key for the "Full Paragraph"/"Full Cell" context mode.

    S-type (document sentence) units group by the paragraph they belong to:
    (doc_prefix, section_index, para_index). A unit missing section_index/
    para_index entirely (docs parsed before the hierarchical-ID scheme
    existed) has no group — matches the frontend's equivalent hasStructure
    fallback in TextViewer.jsx's groupUnitsByStructure, rather than being
    silently lumped into a bogus "paragraph 0" alongside unrelated sentences.

    R-type (cell sentence/delimiter sub-units, from ColumnGranularityControl's
    "Parse inside the cell" splitting) group by the cell they were split
    from: (parent_unit_id, column_name) — there's no section/paragraph
    hierarchy inside a spreadsheet cell, so the whole cell stands in for
    "paragraph" here.

    Any other unit_type (L, H, ...) has no group.
    """
    unit_type = u.get("unit_type")
    if unit_type == "S":
        if "section_index" not in u or "para_index" not in u:
            return None
        doc_prefix = "-".join(u.get("unit_id", "").split("-")[:2])
        return ("S", doc_prefix, u["section_index"], u["para_index"])
    if unit_type == "R":
        parent_id = u.get("parent_unit_id")
        column_name = u.get("column_name")
        if not parent_id or not column_name:
            return None
        return ("R", parent_id, column_name)
    return None


def group_sentences_by_paragraph(units):
    """Group sentence-level sub-units (S-type paragraph sentences, R-type cell
    sentence/delimiter sub-units) by their shared "paragraph" (or cell), for
    the "Full Paragraph"/"Full Cell" context mode (alternative to
    build_context_for_unit's N-neighboring-units mode).

    Returns a dict keyed by _paragraph_group_key(unit) -> list of unit dicts
    sorted by sent_index.
    """
    groups = {}
    for u in units:
        key = _paragraph_group_key(u)
        if key is None:
            continue
        groups.setdefault(key, []).append(u)

    for group in groups.values():
        group.sort(key=lambda u: u.get("sent_index") or 0)

    return groups


def build_paragraph_context_for_unit(unit, paragraph_groups):
    """Context_before / context_after built from the rest of the paragraph (or
    cell) a unit belongs to, split at the unit's own position — the part
    before it, and the part after it. Same (before, after) tuple shape as
    build_context_for_unit() so callers don't need to branch on which mode
    produced it.
    """
    key = _paragraph_group_key(unit)
    if key is None:
        return "", ""

    siblings = paragraph_groups.get(key, [])

    unit_id = unit.get("unit_id", "")
    pos = next((i for i, s in enumerate(siblings) if s.get("unit_id") == unit_id), None)
    if pos is None:
        return "", ""

    before_texts = [s.get("text", "") for s in siblings[:pos]]
    after_texts = [s.get("text", "") for s in siblings[pos + 1:]]

    return " ".join(before_texts), " ".join(after_texts)


def format_unit_content(unit, selected_columns=None):
    """Format unit text, using structured row_data when available.

    R-type cell-sentence units are formatted with their own column's
    sentence first, followed by the row's other selected whole-cell columns
    (excluding the split column itself) as additional context lines.
    """
    row_data = unit.get("row_data")
    column_name = unit.get("column_name")

    if column_name:
        lines = [f"{column_name}: {unit['text']}"]
        if row_data and selected_columns:
            lines += [
                f"{col}: {row_data[col]}" for col in selected_columns
                if col in row_data and col != column_name
            ]
        elif row_data:
            lines += [f"{col}: {val}" for col, val in row_data.items() if col != column_name]
        return "\n".join(lines)

    if row_data and selected_columns:
        return "\n".join(
            f"{col}: {row_data[col]}" for col in selected_columns if col in row_data
        )
    elif row_data:
        return "\n".join(f"{col}: {val}" for col, val in row_data.items())
    else:
        return unit["text"]


def open_csv(path, write_header, fieldnames):
    """Open a CSV file for appending."""
    is_new = not os.path.exists(path) or write_header
    f = open(path, "a" if not write_header else "w", newline="", encoding="utf-8")
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    if is_new:
        writer.writeheader()
    return f, writer


def extract_bool_confidence(logprobs, is_true):
    """Extract confidence for TRUE/FALSE token."""
    if not logprobs:
        return 50.0
    from services.confidence_scorer import logprob_to_confidence
    if isinstance(logprobs, list) and logprobs:
        first = logprobs[0]
        if isinstance(first, (int, float)):
            return logprob_to_confidence(first)
        if isinstance(first, dict):
            return logprob_to_confidence(first.get("logprob", 0))
    return 50.0


def extract_label_confidence(logprobs):
    """Extract confidence for label tokens."""
    if not logprobs:
        return 50.0
    from services.confidence_scorer import multi_token_confidence
    values = []
    for lp in logprobs:
        if isinstance(lp, (int, float)):
            values.append(lp)
        elif isinstance(lp, dict):
            values.append(lp.get("logprob", 0))
    return multi_token_confidence(values) if values else 50.0


def parse_label_response(text):
    """Parse label and reasoning from LLM response."""
    lines = text.strip().split("\n")
    label = lines[0].strip().strip('"').strip("'")
    reasoning = " ".join(lines[1:]).strip() if len(lines) > 1 else ""
    return label, reasoning


def resolve_doc_indices(proj_dir, block_data):
    """Resolve doc_indices from block source_type configuration."""
    source_type = block_data.get("source_type", "all")
    doc_indices = None
    if source_type == "single":
        doc_indices = [int(block_data["source_doc_index"])]
    elif source_type == "folder":
        folder_name = block_data.get("source_folder_name")
        folders_path = os.path.join(proj_dir, "folders.json")
        if folder_name and os.path.exists(folders_path):
            with open(folders_path, "r", encoding="utf-8") as f:
                folders_data = json.load(f)
            for entry in folders_data.get("folders", []):
                if entry["folder_name"] == folder_name:
                    doc_indices = entry["doc_indices"]
                    break
    return doc_indices


# ── Execution environment (hardware / Ollama server / parallelism) ─────────

def analysis_workers(project):
    """Units in flight at once for an analysis run. 1 (default) = sequential and
    replicable; >1 only if the user enabled parallel analysis for this project."""
    try:
        return max(1, min(int(project.get("parallel_analysis_slots") or 1), 8))
    except (TypeError, ValueError):
        return 1


def write_run_environment(block_dir, client, workers):
    """Record the conditions this analysis ran under next to its outputs
    (blocks/<id>/run_environment.json) — never fails the run."""
    import json as _json
    import os as _os
    from datetime import datetime as _dt, timezone as _tz
    try:
        from services.run_conditions import execution_environment
        env = execution_environment(client, workers)
        env.update({
            "recorded_at": _dt.now(_tz.utc).isoformat(),
            "model": client.model,
            "sampling": {"temperature": client.temperature, "seed": client.seed, "top_k": client.top_k,
                         "top_p": client.top_p, "repeat_penalty": client.repeat_penalty,
                         "num_ctx": client.num_ctx or "Ollama default"},
            "replicable_sequential": workers == 1,
        })
        _os.makedirs(block_dir, exist_ok=True)
        with open(_os.path.join(block_dir, "run_environment.json"), "w", encoding="utf-8") as f:
            _json.dump(env, f, indent=2)
    except Exception as e:  # reporting must never break an analysis
        print(f"[run_environment] could not record: {e}")
