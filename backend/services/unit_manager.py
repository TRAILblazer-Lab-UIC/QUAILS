"""Unit ID scheme, context windows, and inventory management."""

import os
import json
import re
from datetime import datetime, timezone

from models.unit import Unit
from services.segmenter import (
    segment_sentences, segment_document, segment_lines, segment_by_delimiters,
    segment_sentences_and_delimiters, extract_structure,
)
from services.version_control import commit_project

UNIT_TYPE_MAP = {
    "sentence": "S",
    "paragraph": "P",
    "document": "D",
    "line": "L",
    "section": "C",
}


def _build_row_data_lookup(parsed_doc):
    """Build a mapping from cleaned line text to its row_data dict."""
    row_data_list = parsed_doc.get("row_data")
    lines = parsed_doc.get("lines")
    if not row_data_list or not lines:
        return {}
    lookup = {}
    for line, rd in zip(lines, row_data_list):
        if rd is None:
            continue
        cleaned = re.sub(r'\s+', ' ', line.strip())
        if cleaned:
            lookup[cleaned] = rd
    return lookup


def build_units(parsed_doc, project_short, doc_index, unit_type="sentence", context_window=1):
    """Segment a parsed document into units with hierarchical IDs and context windows.

    New ID format:
      Sentence : {proj}-{doc:03d}-S-{sec:03d}-{para:03d}-{sent:04d}
      Paragraph: {proj}-{doc:03d}-P-{sec:03d}-{para:03d}
      Header   : {proj}-{doc:03d}-H-{sec:03d}  (always emitted alongside content units)
      Section  : {proj}-{doc:03d}-C-{sec:03d}
      Document : {proj}-{doc:03d}-D
      Line     : {proj}-{doc:03d}-L-{line:05d}
      Row-sentence: {proj}-{doc:03d}-R-{line:05d}-{col:03d}-{sent:04d}
        (sentence/segment split from one column's cell within a tabular row;
         only created via unit_manager.reparse_column(), never at initial parse;
         always carries parent_unit_id pointing at the row's L-type unit)
    """
    fmt = parsed_doc.get("format", "")

    # ── Tabular: line-based units (unchanged) ──────────────────────────────
    if fmt in ("csv", "xlsx", "xls", "numbers") or unit_type == "line":
        lines = parsed_doc.get("lines") or parsed_doc.get("text", "").splitlines()
        segments = segment_lines(lines)
        rd_lookup = _build_row_data_lookup(parsed_doc)
        units = []
        for i, text in enumerate(segments):
            uid = f"{project_short}-{doc_index:03d}-L-{i:05d}"
            before = " ".join(segments[max(0, i - context_window):i])
            after = " ".join(segments[i + 1:i + context_window + 1])
            units.append(Unit(
                unit_id=uid, text=text, unit_type="L",
                doc_index=doc_index, unit_index=i,
                context_before=before, context_after=after,
                row_data=rd_lookup.get(text),
            ))
        return units

    # ── Document-level: single unit ────────────────────────────────────────
    if unit_type == "document":
        text = parsed_doc.get("text", "")
        cleaned = re.sub(r'\s+', ' ', text).strip()
        if not cleaned:
            return []
        uid = f"{project_short}-{doc_index:03d}-D"
        return [Unit(
            unit_id=uid, text=cleaned, unit_type="D",
            doc_index=doc_index, unit_index=0,
        )]

    # ── Hierarchical: sentence, paragraph, section ─────────────────────────
    structure = extract_structure(parsed_doc)
    units = []
    flat_index = 0

    for section in structure["sections"]:
        sec_i = section["section_index"]
        heading = section.get("heading")

        # Always emit header unit when a section has a heading.
        # H units are always stored (the viewer needs them) but filtered at
        # analysis time based on project.include_headers setting.
        if heading:
            uid = f"{project_short}-{doc_index:03d}-H-{sec_i:03d}"
            units.append(Unit(
                unit_id=uid,
                text=heading["text"],
                unit_type="H",
                doc_index=doc_index,
                unit_index=flat_index,
                section_index=sec_i,
                para_index=0,
                is_header=True,
                heading_level=heading.get("level", 1),
            ))
            flat_index += 1

        if unit_type == "section":
            all_text = " ".join(p["text"] for p in section["paragraphs"])
            all_text = re.sub(r'\s+', ' ', all_text).strip()
            if all_text:
                uid = f"{project_short}-{doc_index:03d}-C-{sec_i:03d}"
                units.append(Unit(
                    unit_id=uid,
                    text=all_text,
                    unit_type="C",
                    doc_index=doc_index,
                    unit_index=flat_index,
                    section_index=sec_i,
                    para_index=0,
                ))
                flat_index += 1

        else:
            for para in section["paragraphs"]:
                para_i = para["para_index"]
                para_text = para["text"]
                row_data = para.get("row_data")

                if unit_type == "paragraph":
                    uid = f"{project_short}-{doc_index:03d}-P-{sec_i:03d}-{para_i:03d}"
                    units.append(Unit(
                        unit_id=uid,
                        text=para_text,
                        unit_type="P",
                        doc_index=doc_index,
                        unit_index=flat_index,
                        section_index=sec_i,
                        para_index=para_i,
                        row_data=row_data,
                    ))
                    flat_index += 1

                else:  # sentence (default)
                    for sent_i, sent_text in enumerate(para["sentences"]):
                        uid = f"{project_short}-{doc_index:03d}-S-{sec_i:03d}-{para_i:03d}-{sent_i:04d}"
                        units.append(Unit(
                            unit_id=uid,
                            text=sent_text,
                            unit_type="S",
                            doc_index=doc_index,
                            unit_index=flat_index,
                            section_index=sec_i,
                            para_index=para_i,
                            sent_index=sent_i,
                        ))
                        flat_index += 1

    # ── Context windows (skip H units for content context) ─────────────────
    content_idxs = [i for i, u in enumerate(units) if not u.is_header]
    for pos, unit_idx in enumerate(content_idxs):
        unit = units[unit_idx]
        lo = max(0, pos - context_window)
        hi = min(len(content_idxs), pos + context_window + 1)
        unit.context_before = " ".join(
            units[content_idxs[j]].text for j in range(lo, pos)
        )
        unit.context_after = " ".join(
            units[content_idxs[j]].text for j in range(pos + 1, hi)
        )

    return units


def apply_column_reparse(doc_json, project_short, doc_index, column_name, method="sentence", delimiters=None):
    """Split one column's cells into R-type sentence sub-units, mutating doc_json in place.

    Idempotent: replaces any previously generated R-type sub-units for this
    column before regenerating, so re-running never duplicates. Rows whose
    cell is missing/empty are simply skipped (their L-type row unit is left
    as the only representation of that row).

    `method` is one of:
      "sentence"  — NLTK/regex sentence-boundary segmentation only.
      "delimiter" — literal split on `delimiters` only.
      "both"      — sentence segmentation first, then each resulting
                    sentence is further split on `delimiters` (catches
                    separators like ";" that aren't sentence-ending
                    punctuation, while keeping abbreviation-aware period
                    handling for the sentence pass).

    `delimiters` (required for method="delimiter"/"both") may be a single
    string or a list of strings — a cell is split wherever ANY of them
    occurs, so rows that use different separators can be re-parsed together.
    """
    if doc_json.get("format") not in ("csv", "xlsx", "xls", "numbers"):
        raise ValueError("Column re-parse is only supported for tabular documents")
    columns = doc_json.get("columns") or []
    if column_name not in columns:
        raise ValueError(f"Column '{column_name}' not found in document")
    if method not in ("sentence", "delimiter", "both"):
        raise ValueError(f"Unknown split method '{method}'")
    if isinstance(delimiters, str):
        delimiters = [delimiters]
    delimiters = [d for d in (delimiters or []) if d]
    if method in ("delimiter", "both") and not delimiters:
        raise ValueError(f"At least one delimiter is required when method is '{method}'")

    col_idx = columns.index(column_name)
    units = doc_json.setdefault("units", [])

    # Idempotent replace: drop this column's previous sub-units before regenerating.
    units[:] = [u for u in units if not (u.get("unit_type") == "R" and u.get("column_name") == column_name)]

    next_unit_index = max((u.get("unit_index", 0) for u in units), default=-1) + 1
    new_units = []
    for row_unit in units:
        if row_unit.get("unit_type") != "L":
            continue
        row_data = row_unit.get("row_data") or {}
        cell_text = row_data.get(column_name)
        if not cell_text:
            continue
        if method == "sentence":
            segments = segment_sentences(cell_text)
        elif method == "delimiter":
            segments = segment_by_delimiters(cell_text, delimiters)
        else:  # "both"
            segments = segment_sentences_and_delimiters(cell_text, delimiters)
        for sent_i, seg_text in enumerate(segments):
            uid = f"{project_short}-{doc_index:03d}-R-{row_unit['unit_index']:05d}-{col_idx:03d}-{sent_i:04d}"
            sub_unit = Unit(
                unit_id=uid, text=seg_text, unit_type="R",
                doc_index=doc_index, unit_index=next_unit_index,
                parent_unit_id=row_unit["unit_id"], column_name=column_name,
                sent_index=sent_i,
            )
            new_units.append(sub_unit.to_dict())
            next_unit_index += 1

    units.extend(new_units)
    doc_json.setdefault("column_granularity", {})[column_name] = {
        "method": method,
        "delimiters": delimiters,
        "sub_unit_count": len(new_units),
        "reparsed_at": datetime.now(timezone.utc).isoformat(),
    }
    return {"column_name": column_name, "method": method, "delimiters": delimiters, "sub_unit_count": len(new_units)}


def reparse_column(proj_dir, project_short, doc_index, column_name, method="sentence", delimiters=None):
    """Persist a column re-parse: load the parsed doc, split, write back, commit.

    This is the single canonical entry point used both by the Document
    Viewer's explicit "Re-parse Column" action and by the analysis engine's
    on-demand auto-trigger, so both always produce identical results.
    """
    parsed_path = os.path.join(proj_dir, "parsed", f"doc_{doc_index:03d}.json")
    if not os.path.exists(parsed_path):
        raise ValueError(f"Document {doc_index} not found")
    with open(parsed_path, "r", encoding="utf-8") as f:
        doc_json = json.load(f)

    stats = apply_column_reparse(doc_json, project_short, doc_index, column_name, method, delimiters)

    with open(parsed_path, "w", encoding="utf-8") as f:
        json.dump(doc_json, f, indent=2)
    commit_project(proj_dir, f"Re-parsed column '{column_name}' in doc {doc_index} ({method})")
    return stats


def ensure_column_reparsed(proj_dir, project_short, doc_indices, column_name, method="sentence", delimiters=None):
    """Idempotently persist a reparse of `column_name` on every doc in scope that
    has that column and hasn't already been split. Same idempotency check
    `llm_utils.load_all_units()` does inline before its own auto-trigger, extracted
    here so a reparse can also be persisted proactively (e.g. as soon as a block's
    settings panel configures sentence-level splitting) without waiting for an
    actual analysis/alignment run.

    `doc_indices=None` means "every doc in parsed/", matching load_all_units()'s
    "all docs" convention.
    """
    parsed_dir = os.path.join(proj_dir, "parsed")
    reparsed, already_parsed, skipped = [], [], []
    if not os.path.exists(parsed_dir):
        return {"reparsed_doc_indices": reparsed, "already_parsed_doc_indices": already_parsed, "skipped_doc_indices": skipped}

    for fname in sorted(os.listdir(parsed_dir)):
        if not fname.endswith(".json"):
            continue
        try:
            doc_index = int(fname.replace("doc_", "").replace(".json", ""))
        except ValueError:
            continue
        if doc_indices is not None and doc_index not in doc_indices:
            continue

        with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f:
            doc_json = json.load(f)

        if doc_json.get("format") not in ("csv", "xlsx", "xls", "numbers"):
            skipped.append(doc_index)
            continue
        if column_name not in (doc_json.get("columns") or []):
            skipped.append(doc_index)
            continue
        if (doc_json.get("column_granularity") or {}).get(column_name):
            already_parsed.append(doc_index)
            continue

        reparse_column(proj_dir, project_short, doc_index, column_name, method=method, delimiters=delimiters)
        reparsed.append(doc_index)

    return {"reparsed_doc_indices": reparsed, "already_parsed_doc_indices": already_parsed, "skipped_doc_indices": skipped}


def reset_column_granularity(proj_dir, doc_index, column_name):
    """Remove a column's R-type sub-units and its column_granularity entry, reverting to whole-cell."""
    parsed_path = os.path.join(proj_dir, "parsed", f"doc_{doc_index:03d}.json")
    if not os.path.exists(parsed_path):
        raise ValueError(f"Document {doc_index} not found")
    with open(parsed_path, "r", encoding="utf-8") as f:
        doc_json = json.load(f)

    units = doc_json.setdefault("units", [])
    before = len(units)
    units[:] = [u for u in units if not (u.get("unit_type") == "R" and u.get("column_name") == column_name)]
    removed_count = before - len(units)
    doc_json.get("column_granularity", {}).pop(column_name, None)

    with open(parsed_path, "w", encoding="utf-8") as f:
        json.dump(doc_json, f, indent=2)
    commit_project(proj_dir, f"Reset column '{column_name}' to whole-cell in doc {doc_index}")
    return {"column_name": column_name, "removed_count": removed_count}
