"""Optimizer side of alignment prompt optimization: read dev-split disagreements
(with the human's rationales), ask a *different* Ollama model to hypothesise why
the block prompt misaligns, and parse its proposed revision defensively.

Ported from the psychpaper calibration harness (`local/harness/optimizer.py`).
Holdout cases must never reach this module — `build_optimizer_prompt` asserts it.

Human rationales are the primary evidence here: they state the decision rule
the human applied, which is exactly what a prompt revision has to encode. They
are never used in any agreement statistic (see agreement_stats.py).
"""

import json
import re

CHARS_PER_TOKEN = 2.5          # conservative floor (psychpaper method §8)
BUDGET_FRACTION = 0.70         # share of usable prompt capacity for the optimizer prompt
TEXT_CHARS = 700
CONTEXT_CHARS = 250
REASONING_CHARS = 400
RATIONALE_CHARS = 600
MAX_ANCHORS = 3
MAX_PROMPT_CHARS = 4000


class HoldoutLeak(RuntimeError):
    """Raised if a holdout case is about to be shown to the optimizer."""


# ---------------------------------------------------------------------------
# Correctness helpers (shared with optimization_job)
# ---------------------------------------------------------------------------

def _norm_score(v):
    if v is None:
        return ""
    s = str(v).strip()
    try:
        f = float(s)
        return str(int(f)) if f.is_integer() else str(f)
    except ValueError:
        return s.lower()


def scores_equal(a, b):
    return _norm_score(a) != "" and _norm_score(a) == _norm_score(b)


def scores_within_one(a, b):
    try:
        return abs(float(a) - float(b)) <= 1
    except (TypeError, ValueError):
        return scores_equal(a, b)


def _clip(text, limit):
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f" [truncated: showing {limit} of {len(text)} chars]"


# ---------------------------------------------------------------------------
# Disagreements
# ---------------------------------------------------------------------------

def gather_cases(job, human_labels, units_by_id, llm_results, rubric_items=None):
    """Classify every dev case evaluated for a candidate on one model.

    Returns (disagreements, agreements). Each item is a dict ready for the prompt.
    `human_labels` is read live (so rationales added mid-job are seen);
    human *codes* come from the job's frozen snapshot.
    """
    dev = set(job["split"]["dev_ids"])
    codes = job["human_codes"]
    fixed = job.get("fixed_settings", {})
    disagreements, agreements = [], []

    for uid in job["split"]["dev_ids"]:
        if uid not in dev or uid not in llm_results or uid not in codes:
            continue
        unit = units_by_id.get(uid, {})
        live = human_labels.get(uid) or {}
        r = llm_results[uid]
        base = {
            "unit_id": uid,
            "text": unit.get("text", ""),
            "context_before": unit.get("context_before", ""),
            "context_after": unit.get("context_after", ""),
        }

        if job["block_type"] == "sourceAnalysis":
            h = codes[uid]
            h_det = (h.get("detection") or "").upper()
            m_det = (r.get("detection") or "").upper()
            conf = r.get("detection_confidence") or 0
            case = {
                **base,
                "human_decision": h_det,
                "human_labels": h.get("labels") or [],
                "human_rationale": (live.get("rationale") or "").strip(),
                "rationale_post_hoc": bool(live.get("rationale_post_hoc")),
                "model_decision": m_det,
                "model_confidence": conf,
                "model_labels": r.get("labels") or [],
                "model_reasoning": r.get("reasoning", ""),
                "confident": conf >= float(fixed.get("detection_threshold") or 70),
            }
            if h_det != m_det:
                case["kind"] = "missed_true" if h_det == "TRUE" else "false_true"
                disagreements.append(case)
            elif h_det == "TRUE" and not _labels_overlap(case["human_labels"], case["model_labels"]):
                case["kind"] = "labels"
                disagreements.append(case)
            else:
                agreements.append(case)

        else:  # rubricAnalysis
            h_scores = codes[uid].get("rubric_scores") or {}
            rats = live.get("rubric_rationales") or {}
            for idx, item in enumerate(rubric_items or []):
                key = f"rubric_{idx + 1}"
                hv = h_scores.get(key)
                if hv in (None, ""):
                    continue
                mv = (r.get("rubric_scores") or {}).get(key, "")
                conf = (r.get("rubric_confidences") or {}).get(key) or 0
                case = {
                    **base,
                    "kind": key,
                    "rubric_key": key,
                    "rubric_title": item.get("title") or key,
                    "human_decision": str(hv),
                    "human_rationale": (rats.get(key) or "").strip(),
                    "rationale_post_hoc": bool(live.get("rationale_post_hoc")),
                    "model_decision": str(mv),
                    "model_confidence": conf,
                    "model_reasoning": (r.get("rubric_justifications") or {}).get(key, ""),
                    "confident": conf >= float(fixed.get("label_threshold") or 70),
                }
                (agreements if scores_equal(hv, mv) else disagreements).append(case)

    # Most diagnostic first: confident-and-wrong, then has a human rationale.
    disagreements.sort(key=lambda c: (-int(c["confident"]), -int(bool(c["human_rationale"])), c["unit_id"]))
    agreements.sort(key=lambda c: (-int(bool(c["human_rationale"])), c["unit_id"]))
    return disagreements, agreements


def _labels_overlap(h, m):
    from services.similarity import text_similarity
    if not h or not m:
        return not h and not m
    return any(text_similarity(a, b) >= 50 for a in h for b in m)


# ---------------------------------------------------------------------------
# Focus selection (candidate diversity)
# ---------------------------------------------------------------------------

SOURCE_FOCUS_TEXT = {
    "missed_true": "The model says FALSE where the human found the goal present (missed codes). Concentrate on why the detection prompt is too narrow.",
    "false_true": "The model says TRUE where the human found the goal absent (over-coding). Concentrate on why the detection prompt is too broad.",
    "labels": "Both agree the goal is present but the model's labels differ from the human's. Concentrate on the label prompt.",
    "all": "Address the most frequent disagreement pattern across all cases.",
}


def choose_focuses(block_type, disagreements, k, rubric_items=None):
    counts = {}
    for c in disagreements:
        counts[c["kind"]] = counts.get(c["kind"], 0) + 1
    ordered = [kind for kind, _ in sorted(counts.items(), key=lambda kv: -kv[1])]
    focuses = ordered[:k]
    while len(focuses) < k:
        focuses.append("all")
    return focuses


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _case_block(n, c, block_type, anchor=False):
    lines = [f"--- {'anchor' if anchor else 'case'} {n} ({c['unit_id']}){'' if anchor else ' [' + c['kind'] + ']'} ---"]
    if c.get("context_before"):
        lines.append(f"Context before: {_clip(c['context_before'], CONTEXT_CHARS)}")
    lines.append(f"Text: {_clip(c['text'], TEXT_CHARS)}")
    if c.get("context_after"):
        lines.append(f"Context after: {_clip(c['context_after'], CONTEXT_CHARS)}")
    if block_type == "sourceAnalysis":
        ml = ", ".join(c.get("model_labels") or []) or "(none)"
        hl = ", ".join(c.get("human_labels") or []) or "(none)"
        lines.append(f"MODEL said: {c['model_decision']} (confidence {c['model_confidence']:.0f}%) labels: {ml}")
        if c.get("model_reasoning"):
            lines.append(f"MODEL reasoning: {_clip(c['model_reasoning'], REASONING_CHARS)}")
        lines.append(f"HUMAN said: {c['human_decision']} labels: {hl}")
    else:
        lines.append(f"Rubric item: {c['rubric_title']} ({c['rubric_key']})")
        lines.append(f"MODEL score: {c['model_decision'] or '(blank)'} (confidence {c['model_confidence']:.0f}%)")
        if c.get("model_reasoning"):
            lines.append(f"MODEL reasoning: {_clip(c['model_reasoning'], REASONING_CHARS)}")
        lines.append(f"HUMAN score: {c['human_decision']}")
    if c.get("human_rationale"):
        tag = " (written after seeing model output)" if c.get("rationale_post_hoc") else ""
        lines.append(f"HUMAN RATIONALE{tag}: {_clip(c['human_rationale'], RATIONALE_CHARS)}")
    else:
        lines.append("HUMAN RATIONALE: (none given)")
    return "\n".join(lines) + "\n"


def _header(block_type, prompts, focus, rubric_items):
    if block_type == "sourceAnalysis":
        return (
            "You are improving the prompts used by an automated qualitative-coding step (open coding) in a research tool.\n"
            "For each text unit the coding model makes two calls:\n"
            "  1. DETECTION PROMPT (system prompt): the model answers only TRUE or FALSE - is the analysis goal present in this unit?\n"
            "  2. LABEL PROMPT (follow-up, only after TRUE): the model gives short descriptive code labels.\n"
            "A human researcher coded the same units. The human's codes are the reference standard. Where the human wrote a\n"
            "RATIONALE, it states the decision rule they applied - treat the rationales as your most important evidence.\n\n"
            f"CURRENT DETECTION PROMPT:\n<<<\n{prompts.get('detection_prompt', '')}\n>>>\n\n"
            f"CURRENT LABEL PROMPT:\n<<<\n{prompts.get('label_prompt', '')}\n>>>\n\n"
            f"FOCUS FOR THIS REVISION: {SOURCE_FOCUS_TEXT.get(focus, SOURCE_FOCUS_TEXT['all'])}\n\n"
        )
    items_txt = []
    for idx, item in enumerate(rubric_items or []):
        key = f"rubric_{idx + 1}"
        items_txt.append(
            f"[{key}] {item.get('title') or key}\nDescription: {item.get('description', '')}\n"
            f"Scoring prompt:\n<<<\n{item.get('scoring_prompt', '')}\n>>>\n")
    focus_txt = (f"Revise the scoring prompt for {focus} only." if focus.startswith("rubric_")
                 else "Revise the scoring prompts of the items with the most disagreement.")
    return (
        "You are improving the scoring prompts used by an automated rubric-scoring step in a qualitative research tool.\n"
        "For each text unit and each rubric item the model receives the item's title, description and scoring prompt,\n"
        "and answers with a score. A human researcher scored the same units; the human's scores are the reference standard.\n"
        "Where the human wrote a RATIONALE, it states the rule they applied - treat the rationales as your most important evidence.\n\n"
        "CURRENT RUBRIC ITEMS:\n" + "\n".join(items_txt) + "\n"
        f"FOCUS FOR THIS REVISION: {focus_txt}\n\n"
    )


def _footer(block_type):
    if block_type == "sourceAnalysis":
        keys = ('"hypotheses": [{"hypothesis": str, "evidence_unit_ids": [str], "rationale_quote": str}], '
                '"diagnosis": str, "revised_detection_prompt": str, "revised_label_prompt": str, '
                '"change_rationale": str, "confidence": "high" | "low"')
        semantics = ("- Keep the decision semantics: the detection prompt must still be answerable with only TRUE or FALSE,\n"
                     "  and the label prompt must still ask for short comma-separated code labels.\n")
    else:
        keys = ('"hypotheses": [{"hypothesis": str, "evidence_unit_ids": [str], "rationale_quote": str}], '
                '"diagnosis": str, "revised_scoring_prompts": {"rubric_N": str}, '
                '"change_rationale": str, "confidence": "high" | "low"')
        semantics = ("- Keep the same scoring scale and response format each scoring prompt already asks for.\n"
                     "- Only include rubric items you actually revise in revised_scoring_prompts.\n")
    return (
        "\nTASK\n"
        "1. Read the HUMAN RATIONALES and extract the decision rule(s) the human is applying.\n"
        "2. Contrast that rule with the MODEL reasoning. State 1-3 hypotheses about which wording in the current prompt(s)\n"
        "   causes the disagreement. For each, cite the case unit_ids and quote the human rationale that supports it.\n"
        "3. Write a short diagnosis summarising the hypotheses.\n"
        "4. Propose revised prompt wording that addresses ONLY those hypotheses.\n\n"
        "CONSTRAINTS\n"
        + semantics +
        "- Preserve every instruction about the response format that the current prompt gives.\n"
        "- Anchor cases are ones the model already gets right - the revision must not break them.\n"
        "- Prefer a general rule over a fix for a single case. Do not mention case ids or quote case text inside the revised prompts.\n"
        "- Do not use {{ }} placeholders. Do not use markdown or code fences.\n"
        "- Write the hypotheses and diagnosis BEFORE the revision, and make the revision follow from them.\n\n"
        f"Respond with ONLY a single JSON object with these keys: {keys}\n"
    )


def build_optimizer_prompt(job, prompts, focus, disagreements, agreements, num_ctx, rubric_items=None):
    """Assemble the optimizer prompt under a token budget. Returns (prompt, budget_info)."""
    holdout = set(job["split"]["holdout_ids"])
    leaked = [c["unit_id"] for c in disagreements + agreements if c["unit_id"] in holdout]
    if leaked:
        raise HoldoutLeak(f"Holdout cases would be shown to the optimizer: {leaked[:5]}")

    block_type = job["block_type"]
    if focus not in ("all",) and block_type == "sourceAnalysis":
        focused = [c for c in disagreements if c["kind"] == focus]
        rest = [c for c in disagreements if c["kind"] != focus]
        pool = focused + rest
    elif focus.startswith("rubric_"):
        pool = [c for c in disagreements if c["rubric_key"] == focus] + \
               [c for c in disagreements if c["rubric_key"] != focus]
    else:
        pool = list(disagreements)

    header = _header(block_type, prompts, focus, rubric_items)
    footer = _footer(block_type)
    capacity_tokens = max(num_ctx // 2, 1024)
    budget_chars = int(capacity_tokens * BUDGET_FRACTION * CHARS_PER_TOKEN)
    used = len(header) + len(footer) + 200

    blocks, included, dropped = [], [], []
    body = "DISAGREEMENT CASES (the human's code is the reference standard):\n\n"
    used += len(body)
    for c in pool:
        b = _case_block(len(included) + 1, c, block_type)
        if included and used + len(b) > budget_chars:
            dropped.append(c["unit_id"])
            continue
        blocks.append(b)
        included.append(c)
        used += len(b)

    anchors = [a for a in agreements if a.get("human_rationale")][:MAX_ANCHORS]
    anchor_txt = ""
    included_anchors = []
    if anchors:
        anchor_txt = "\nAGREEMENT ANCHORS (model and human already agree - keep this behaviour):\n\n"
        for a in anchors:
            b = _case_block(len(included_anchors) + 1, a, block_type, anchor=True)
            if used + len(anchor_txt) + len(b) > budget_chars:
                break
            anchor_txt += b
            included_anchors.append(a["unit_id"])
            used += len(b)

    prompt = header + body + "\n".join(blocks) + anchor_txt + footer
    with_rat = sum(1 for c in included if c.get("human_rationale"))
    budget = {
        "num_ctx": num_ctx,
        "capacity_tokens": capacity_tokens,
        "budget_chars": budget_chars,
        "prompt_chars": len(prompt),
        "estimated_tokens": int(len(prompt) / CHARS_PER_TOKEN),
        "cases_available": len(pool),
        "cases_included": len(included),
        "cases_dropped": len(dropped),
        "included_unit_ids": [c["unit_id"] for c in included],
        "dropped_unit_ids": dropped,
        "anchor_unit_ids": included_anchors,
        "cases_with_rationale": with_rat,
        "selection_rule": "confident-and-wrong first, then cases with a human rationale; greedy under budget",
    }
    return prompt, budget


def response_schema(block_type):
    hyp = {"type": "array", "items": {"type": "object", "properties": {
        "hypothesis": {"type": "string"},
        "evidence_unit_ids": {"type": "array", "items": {"type": "string"}},
        "rationale_quote": {"type": "string"}}, "required": ["hypothesis"]}}
    props = {"hypotheses": hyp, "diagnosis": {"type": "string"}}
    if block_type == "sourceAnalysis":
        props.update({"revised_detection_prompt": {"type": "string"},
                      "revised_label_prompt": {"type": "string"}})
        req = ["hypotheses", "diagnosis", "revised_detection_prompt", "revised_label_prompt"]
    else:
        props["revised_scoring_prompts"] = {"type": "object", "additionalProperties": {"type": "string"}}
        req = ["hypotheses", "diagnosis", "revised_scoring_prompts"]
    props.update({"change_rationale": {"type": "string"},
                  "confidence": {"type": "string", "enum": ["high", "low"]}})
    return {"type": "object", "properties": props, "required": req}


# ---------------------------------------------------------------------------
# Defensive parsing (Ollama's format= schema is not reliably enforced)
# ---------------------------------------------------------------------------

_KEY_ALIASES = {
    "revised_detection_prompt": ["detection_prompt", "revised_detection", "new_detection_prompt"],
    "revised_label_prompt": ["label_prompt", "revised_label", "new_label_prompt", "revised_labeling_prompt"],
    "revised_scoring_prompts": ["scoring_prompts", "revised_rubric_prompts", "rubric_prompts", "revised_prompts"],
    "hypotheses": ["hypothesis", "hypotheses_list"],
    "diagnosis": ["analysis", "diagnosis_summary"],
    "change_rationale": ["rationale", "changes", "explanation"],
}


def salvage_json(text):
    if not text:
        return None
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    try:
        return json.loads(t)
    except ValueError:
        pass
    start = t.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(t)):
            if t[i] == "{":
                depth += 1
            elif t[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[start:i + 1])
                    except ValueError:
                        break
        start = t.find("{", start + 1)
    return None


def normalize_proposal(raw_text, block_type, dev_ids):
    """Returns (proposal | None, notes[])."""
    notes = []
    data = salvage_json(raw_text)
    if not isinstance(data, dict):
        return None, ["Response was not parseable JSON."]
    for canon, aliases in _KEY_ALIASES.items():
        if canon not in data:
            for a in aliases:
                if a in data:
                    data[canon] = data.pop(a)
                    notes.append(f"Remapped key '{a}' -> '{canon}'.")
                    break

    hyps = data.get("hypotheses") or []
    if isinstance(hyps, str):
        hyps = [{"hypothesis": hyps}]
        notes.append("Hypotheses arrived as a string; wrapped as one hypothesis.")
    clean_hyps, dev = [], set(dev_ids)
    for h in hyps if isinstance(hyps, list) else []:
        if isinstance(h, str):
            h = {"hypothesis": h}
        if not isinstance(h, dict) or not h.get("hypothesis"):
            continue
        ev = h.get("evidence_unit_ids") or []
        if isinstance(ev, str):
            ev = [e.strip() for e in re.split(r"[,\s]+", ev) if e.strip()]
        kept = [e for e in ev if e in dev]
        if len(kept) != len(ev):
            notes.append(f"Dropped {len(ev) - len(kept)} cited id(s) not in the development set.")
        clean_hyps.append({"hypothesis": str(h["hypothesis"]).strip(),
                           "evidence_unit_ids": kept,
                           "rationale_quote": str(h.get("rationale_quote") or "").strip()})
    if not clean_hyps:
        notes.append("No usable hypotheses returned.")

    out = {
        "hypotheses": clean_hyps,
        "diagnosis": str(data.get("diagnosis") or "").strip(),
        "change_rationale": str(data.get("change_rationale") or "").strip(),
        "confidence": data.get("confidence") if data.get("confidence") in ("high", "low") else "low",
    }
    if data.get("confidence") not in ("high", "low"):
        notes.append("Confidence missing or invalid; set to 'low'.")
    if not out["diagnosis"]:
        notes.append("Diagnosis missing.")

    if block_type == "sourceAnalysis":
        det = str(data.get("revised_detection_prompt") or "").strip()
        lab = str(data.get("revised_label_prompt") or "").strip()
        if not det and not lab:
            return None, notes + ["No revised prompt text returned."]
        out["revised_detection_prompt"] = det
        out["revised_label_prompt"] = lab
        if not det:
            notes.append("Detection prompt not revised; current wording kept.")
        if not lab:
            notes.append("Label prompt not revised; current wording kept.")
    else:
        sp = data.get("revised_scoring_prompts")
        if isinstance(sp, list):
            sp = {f"rubric_{i + 1}": v for i, v in enumerate(sp) if v}
            notes.append("Scoring prompts arrived as a list; mapped by position.")
        if not isinstance(sp, dict) or not sp:
            return None, notes + ["No revised scoring prompts returned."]
        out["revised_scoring_prompts"] = {str(k): str(v).strip() for k, v in sp.items() if str(v).strip()}
    return out, notes


def apply_proposal(block_type, parent_prompts, proposal):
    """Merge a normalized proposal onto the parent's prompts → candidate prompts."""
    if block_type == "sourceAnalysis":
        return {
            "detection_prompt": proposal.get("revised_detection_prompt") or parent_prompts.get("detection_prompt", ""),
            "label_prompt": proposal.get("revised_label_prompt") or parent_prompts.get("label_prompt", ""),
        }
    items = [dict(i) for i in parent_prompts.get("rubric_items", [])]
    for key, text in (proposal.get("revised_scoring_prompts") or {}).items():
        m = re.match(r"rubric_(\d+)$", key)
        if m and 1 <= int(m.group(1)) <= len(items):
            items[int(m.group(1)) - 1]["scoring_prompt"] = text
    return {"rubric_items": items}


def validate_candidate(block_type, parent_prompts, cand_prompts):
    """Returns a list of problems (empty = valid)."""
    problems = []
    texts = []
    if block_type == "sourceAnalysis":
        texts = [cand_prompts.get("detection_prompt", ""), cand_prompts.get("label_prompt", "")]
        if not cand_prompts.get("detection_prompt", "").strip():
            problems.append("Detection prompt is empty.")
    else:
        items = cand_prompts.get("rubric_items", [])
        if len(items) != len(parent_prompts.get("rubric_items", [])):
            problems.append("Rubric item count changed.")
        texts = [i.get("scoring_prompt", "") for i in items]
    for t in texts:
        if "{{" in t or "}}" in t:
            problems.append("Revised prompt contains a {{ }} placeholder.")
        if len(t) > MAX_PROMPT_CHARS:
            problems.append(f"Revised prompt longer than {MAX_PROMPT_CHARS} characters.")
    if cand_prompts == {k: parent_prompts.get(k) for k in cand_prompts}:
        problems.append("Proposal is identical to the current prompt.")
    return sorted(set(problems))
