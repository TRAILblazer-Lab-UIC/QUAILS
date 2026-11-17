"""Corpus and sampling-frame statistics for reporting (alignment + optimization reports).

Describes what a block analyses: the documents in scope, the unit of analysis,
the sampling frame the alignment sample was drawn from, and how the sample
compares to it. Pure description — no model calls.
"""

import json
import os
import re
import statistics

from config import PROJECTS_DIR

_WORD = re.compile(r"\b\w+\b", re.UNICODE)

UNIT_TYPE_LABEL = {
    "sentence": "sentence", "paragraph": "paragraph", "section": "section",
    "document": "document", "line": "spreadsheet row",
}


def _words(text):
    return len(_WORD.findall(text or ""))


def describe_lengths(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {
        "n": len(values),
        "total": sum(values),
        "mean": round(statistics.fmean(values), 1),
        "sd": round(statistics.stdev(values), 1) if len(values) > 1 else 0.0,
        "median": statistics.median(values),
        "min": min(values),
        "max": max(values),
    }


def _docs(project_id, doc_indices):
    parsed = os.path.join(PROJECTS_DIR, project_id, "parsed")
    out = []
    if not os.path.isdir(parsed):
        return out
    for fname in sorted(os.listdir(parsed)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(parsed, fname), "r", encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        idx = d.get("doc_index")
        if doc_indices is not None and idx not in doc_indices:
            continue
        out.append(d)
    return out


def corpus_statistics(project_id, block_id, sample_unit_ids=None):
    """Statistics for the block's documents, sampling frame and (optionally) the sample."""
    from services.alignment_service import sampling_frame
    from services.llm_utils import format_unit_content

    frame = sampling_frame(project_id, block_id)
    if "error" in frame:
        return {"error": frame["error"]}
    block_type, data, project = frame["block_type"], frame["block_data"], frame["project"]
    if block_type not in ("sourceAnalysis", "rubricAnalysis"):
        return {"error": "Corpus statistics apply to open-coding and rubric blocks (other blocks work from upstream outputs)."}

    docs = _docs(project_id, frame["doc_indices"])
    all_docs = _docs(project_id, None)
    formats = {}
    for d in docs:
        formats[d.get("format", "unknown")] = formats.get(d.get("format", "unknown"), 0) + 1
    folders = sorted({d.get("folder_name") for d in docs if d.get("folder_name")})

    source_type = data.get("source_type", "all")
    if source_type == "single":
        scope = f"single document ({docs[0].get('filename') if docs else 'unknown'})"
    elif source_type == "folder":
        scope = f"folder collection “{data.get('source_folder_name')}”"
    else:
        scope = "all documents in the project"

    selected_columns = data.get("selected_columns") or []
    units = frame["units"]
    texts = {u["unit_id"]: (format_unit_content(u, selected_columns) if u.get("row_data") is not None
                            else u.get("text", "")) for u in units}
    frame_words = describe_lengths([_words(t) for t in texts.values()])
    doc_words = describe_lengths([sum(_words(u.get("text", "")) for u in d.get("units", [])
                                      if not u.get("is_header") and u.get("unit_type") not in ("H", "R"))
                                  for d in docs])

    unit_type = frame["unit_type"]
    unit_desc = UNIT_TYPE_LABEL.get(unit_type, unit_type)
    if data.get("sentence_column"):
        method = data.get("sentence_split_method", "sentence")
        delims = data.get("sentence_split_delimiters") or ([data["sentence_split_delimiter"]] if data.get("sentence_split_delimiter") else [])
        how = {"sentence": "sentence boundaries", "delimiter": f"delimiters {', '.join(repr(d) for d in delims)}",
               "both": f"sentence boundaries and delimiters {', '.join(repr(d) for d in delims)}"}.get(method, method)
        unit_desc = f"segment within the “{data['sentence_column']}” cell (split by {how})"

    if data.get("context_mode") == "paragraph":
        context = "full paragraph" + (" (full cell)" if data.get("sentence_column") else "") + " around each unit"
    elif data.get("context_window") is not None:
        context = f"{data.get('context_window')} neighbouring unit(s) before and after" if int(data.get("context_window") or 0) else "none"
    else:
        context = f"project default ({project.get('context_window', 0)} unit(s))"

    out = {
        "project_documents": len(all_docs),
        "documents_in_scope": len(docs),
        "scope": scope,
        "formats": formats,
        "folders": folders,
        "document_words": doc_words,
        "unit_of_analysis": unit_desc,
        "unit_type": unit_type,
        "context": context,
        "selected_columns": selected_columns,
        "include_headers": bool(project.get("include_headers")),
        "frame_units": len(units),
        "frame_excluded_blank_cells": frame.get("excluded_blank", 0),
        "frame_unit_words": frame_words,
    }
    if sample_unit_ids is not None:
        ids = [u for u in sample_unit_ids if u in texts]
        out["sample_units"] = len(sample_unit_ids)
        out["sample_units_in_current_frame"] = len(ids)
        out["sampling_fraction"] = round(len(sample_unit_ids) / len(units), 4) if units else None
        out["sample_unit_words"] = describe_lengths([_words(texts[u]) for u in ids])
    return out


def corpus_bullets(cs):
    """Report lines (Markdown bullets) for a corpus_statistics() result."""
    if not cs or cs.get("error"):
        return [f"- Corpus statistics unavailable: {(cs or {}).get('error', 'n/a')}"]
    fmt = ", ".join(f"{k} ×{v}" for k, v in sorted(cs["formats"].items())) or "n/a"
    L = [
        f"- Scope analysed by this block: {cs['scope']} — {cs['documents_in_scope']} of {cs['project_documents']} project document(s) ({fmt})"
        + (f"; folder(s): {', '.join(cs['folders'])}" if cs.get("folders") else ""),
    ]
    dw = cs.get("document_words")
    if dw and dw["n"] == 1:
        L.append(f"- Document length: {dw['total']:,} words")
    elif dw:
        L.append(f"- Document length (words): total {dw['total']:,}; mean {dw['mean']} (SD {dw['sd']}), median {dw['median']}, range {dw['min']}–{dw['max']}")
    L.append(f"- Unit of analysis: {cs['unit_of_analysis']}; context shown with each unit: {cs['context']}"
             + (f"; spreadsheet columns used: {', '.join(cs['selected_columns'])}" if cs.get("selected_columns") else "")
             + ("; section headers included" if cs.get("include_headers") else ""))
    fw = cs.get("frame_unit_words")
    L.append(f"- Sampling frame: {cs['frame_units']:,} units"
             + (f" (after excluding {cs['frame_excluded_blank_cells']} blank cell(s))" if cs.get("frame_excluded_blank_cells") else "")
             + (f"; unit length (words) mean {fw['mean']} (SD {fw['sd']}), median {fw['median']}, range {fw['min']}–{fw['max']}" if fw else ""))
    if "sample_units" in cs:
        sw = cs.get("sample_unit_words")
        frac = cs.get("sampling_fraction")
        L.append(f"- Sample: {cs['sample_units']} units ({frac * 100:.1f}% of the frame)" if frac is not None else f"- Sample: {cs['sample_units']} units")
        if sw:
            L.append(f"- Sample unit length (words): mean {sw['mean']} (SD {sw['sd']}), median {sw['median']}, range {sw['min']}–{sw['max']} — compare with the frame above to argue representativeness")
        if cs.get("sample_units_in_current_frame", cs["sample_units"]) < cs["sample_units"]:
            L.append(f"- Note: only {cs['sample_units_in_current_frame']} sampled units are still in the current frame (the corpus or block settings changed after sampling); frame figures describe the current state")
    return L
