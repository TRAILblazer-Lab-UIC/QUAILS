"""Portable exports of an alignment test: long-format CSV and a Markdown conditions report."""

import csv
import io

NOT_RECORDED = "not recorded (this test was run before run-condition snapshots existed)"


def _join(value):
    if isinstance(value, (list, tuple)):
        return "; ".join(str(v) for v in value)
    return "" if value is None else str(value)


def _norm(value):
    return " ".join(_join(value).lower().split())


def build_csv(test):
    """One row per case. Returns CSV text (UTF-8 BOM added by caller via encoding)."""
    block_type = test.get("block_type", "")
    mode = test.get("comparison_mode", "")
    human = test.get("human_labels") or {}
    llm = test.get("llm_results") or {}
    base = ["test_id", "block_id", "block_type", "status"]

    out = io.StringIO()
    writer = None

    def emit(fieldnames, rows):
        w = csv.DictWriter(out, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    meta = {
        "test_id": test.get("test_id", ""),
        "block_id": test.get("block_id", ""),
        "block_type": block_type,
        "status": test.get("status", ""),
    }

    if mode == "single_output" or block_type in ("categoryBuild", "customPrompt"):
        emit(base + ["input_context", "human_expected_output", "human_rationale", "llm_output"],
             [{**meta,
               "input_context": test.get("context_text", ""),
               "human_expected_output": test.get("human_expected", ""),
               "human_rationale": test.get("human_expected_rationale", ""),
               "llm_output": test.get("llm_output", "")}])
        return out.getvalue()

    units = test.get("sample_units") or []
    case_cols = ["unit_id", "text", "context_before", "context_after"]
    rows = []

    if block_type == "rubricAnalysis":
        items = (test.get("prompts_snapshot") or {}).get("rubric_items") or []
        keys = [f"rubric_{i + 1}" for i in range(len(items))]
        cols = []
        for i, k in enumerate(keys):
            title = items[i].get("title") or k
            cols += [f"human_{k}", f"human_{k}_rationale", f"llm_{k}", f"llm_{k}_confidence", f"llm_{k}_justification", f"{k}_match"]
        header = base + case_cols + cols
        for u in units:
            uid = u.get("unit_id")
            h = ((human.get(uid) or {}).get("rubric_scores")) or {}
            hr = ((human.get(uid) or {}).get("rubric_rationales")) or {}
            r = llm.get(uid) or {}
            row = {**meta, **{c: u.get(c, "") for c in case_cols}}
            for k in keys:
                hv, lv = h.get(k, ""), (r.get("rubric_scores") or {}).get(k, "")
                row[f"human_{k}"] = hv
                row[f"human_{k}_rationale"] = hr.get(k, "")
                row[f"llm_{k}"] = lv
                row[f"llm_{k}_confidence"] = (r.get("rubric_confidences") or {}).get(k, "")
                row[f"llm_{k}_justification"] = (r.get("rubric_justifications") or {}).get(k, "")
                row[f"{k}_match"] = (_norm(hv) == _norm(lv)) if (uid in llm and hv != "") else ""
            rows.append(row)
        emit(header, rows)
        return out.getvalue()

    if block_type == "themeIdent":
        header = base + case_cols + ["case_label", "case_rationale", "human_theme_choice",
                                     "human_rationale", "llm_theme_choice", "llm_confidence", "match"]
        for u in units:
            uid = u.get("unit_id")
            h = (human.get(uid) or {}).get("theme_choice", "")
            r = llm.get(uid) or {}
            rows.append({**meta, **{c: u.get(c, "") for c in case_cols},
                         "case_label": u.get("label", ""), "case_rationale": u.get("reasoning", ""),
                         "human_theme_choice": h, "human_rationale": (human.get(uid) or {}).get("rationale", ""),
                         "llm_theme_choice": r.get("theme_choice", ""),
                         "llm_confidence": r.get("confidence", ""),
                         "match": (h == r.get("theme_choice")) if (uid in llm and h) else ""})
        emit(header, rows)
        return out.getvalue()

    # sourceAnalysis (default)
    header = base + case_cols + ["human_detection", "human_labels", "human_rationale", "llm_detection", "llm_detection_confidence",
                                 "llm_labels", "llm_label_confidence", "llm_reasoning", "detection_match"]
    for u in units:
        uid = u.get("unit_id")
        h = human.get(uid) or {}
        r = llm.get(uid) or {}
        rows.append({**meta, **{c: u.get(c, "") for c in case_cols},
                     "human_detection": h.get("detection", ""), "human_labels": _join(h.get("labels")), "human_rationale": h.get("rationale", ""),
                     "llm_detection": r.get("detection", ""),
                     "llm_detection_confidence": r.get("detection_confidence", ""),
                     "llm_labels": _join(r.get("labels")), "llm_label_confidence": r.get("label_confidence", ""),
                     "llm_reasoning": r.get("reasoning", ""),
                     "detection_match": (str(h.get("detection", "")).upper() == str(r.get("detection", "")).upper())
                     if (uid in llm and h.get("detection")) else ""})
    emit(header, rows)
    return out.getvalue()


def _fence(text):
    return "```text\n" + (text or "").replace("```", "'''") + "\n```"


def build_report(test, project_title="", project_id=None):
    """Write-up report for one alignment test: facts, tables and reporting points
    (bullet arguments for the author) — deliberately no drafted manuscript prose."""
    from services import agreement_stats as st
    from services import report_sections as R
    from services.prompt_optimizer import scores_equal, scores_within_one

    rc = test.get("run_conditions") or {}
    prompts = test.get("prompts_snapshot") or {}
    metrics = test.get("metrics") or {}
    human = test.get("human_labels") or {}
    llm = test.get("llm_results") or {}
    bt = test.get("block_type", "")
    mode = test.get("comparison_mode") or ("single_output" if bt in ("categoryBuild", "customPrompt")
                                           else "per_unit_theme_match" if bt == "themeIdent" else "per_unit")
    units = test.get("sample_units") or []
    samp = test.get("sampling") or {}
    L = []
    add = L.append

    add("# Alignment Test — Reporting Materials")
    add("")
    add("> Facts, tables and reporting points for writing up this alignment test. The bullet points state what the numbers "
        "support; the wording of the manuscript is left to the author.")
    add("")
    add("| Item | Value |")
    add("|---|---|")
    add(f"| Project | {project_title or '(unknown)'} |")
    add(f"| Block | {test.get('block_label') or test.get('block_id', '')} (`{test.get('block_id', '')}`, {bt}) |")
    add(f"| Test ID / status | `{test.get('test_id', '')}` / {test.get('status', '')} |")
    add(f"| Created | {test.get('created_at', '')} |")
    add(f"| Comparison mode | {mode} |")
    add("")

    # 1. Corpus and sample
    add("## 1. Corpus, unit of analysis and sample")
    if project_id and bt in ("sourceAnalysis", "rubricAnalysis"):
        from services.corpus_stats import corpus_statistics, corpus_bullets
        try:
            cs = corpus_statistics(project_id, test.get("block_id"),
                                   test.get("sample_unit_ids") or [u["unit_id"] for u in units])
        except Exception as e:  # never fail a report over description
            cs = {"error": str(e)}
        L.extend(corpus_bullets(cs))
    elif mode == "per_unit_theme_match":
        add(f"- Cases are rows of the upstream block's labeled output, compared against a frozen list of "
            f"{len(test.get('theme_reference_list') or [])} theme(s) from the block's last completed run")
    elif mode == "single_output":
        add("- One aggregate output (no per-case sample): the human wrote an expected output for the same input the block receives")
    if samp:
        add(f"- Sampling: {samp.get('method')}, n = {test.get('sample_size')} drawn from a frame of {samp.get('frame_size')}"
            + (f" (requested {test.get('requested_sample_size')})"
               if test.get("requested_sample_size") not in (None, test.get("sample_size")) else "")
            + f"; random seed {samp.get('seed')} (reproducible draw)")
    elif mode != "single_output":
        add(f"- Sampling: simple random sample of n = {test.get('sample_size', len(units))}; "
            "seed not recorded (sample drawn before seeds were stored)")
    add("")

    # 2. Reference standard
    add("## 2. Human reference standard")
    coded = {u: h for u, h in human.items() if isinstance(h, dict)}
    n_rat = sum(1 for h in coded.values() if (h.get("rationale") or "").strip()
                or any((v or "").strip() for v in (h.get("rubric_rationales") or {}).values()))
    post_hoc = sum(1 for h in coded.values() if h.get("rationale_post_hoc"))
    add(f"- Coder: one human rater; {len(coded)} of {len(units) if units else 1} case(s) coded")
    if bt == "sourceAnalysis":
        tr = sum(1 for h in coded.values() if (h.get("detection") or "").upper() == "TRUE")
        labels = [l for h in coded.values() for l in (h.get("labels") or [])]
        if tr:
            add(f"- Human detection: TRUE {tr}, FALSE {len(coded) - tr}; {len(labels)} labels assigned "
                f"({len(set(l.lower() for l in labels))} distinct), mean {len(labels) / tr:.2f} per TRUE case")
        else:
            add(f"- Human detection: TRUE 0, FALSE {len(coded)}")
    elif bt == "rubricAnalysis":
        for i, item in enumerate(prompts.get("rubric_items") or []):
            key = f"rubric_{i + 1}"
            dist = {}
            for h in coded.values():
                v = (h.get("rubric_scores") or {}).get(key)
                if v not in (None, ""):
                    dist[str(v)] = dist.get(str(v), 0) + 1
            add(f"- {item.get('title') or key}: score distribution "
                + (", ".join(f"{k}: {v}" for k, v in sorted(dist.items())) or "none"))
    elif mode == "per_unit_theme_match":
        dist = {}
        for h in coded.values():
            dist[h.get("theme_choice")] = dist.get(h.get("theme_choice"), 0) + 1
        add("- Human theme choices: " + ", ".join(f"{k}: {v}" for k, v in sorted(dist.items(), key=lambda kv: str(kv[0]))))
    add(f"- Rationales: {n_rat} coded case(s) carry a written rationale ({post_hoc} written after seeing model output); "
        "rationales are not used in any statistic")
    rel = (test.get("reliability") or {}).get("computed")
    if rel:
        add(f"- Intra-rater reliability (blind re-code of {rel.get('n')} judgements): {R.pct(rel.get('self_agreement'))} "
            "self-agreement — the ceiling against which model agreement should be read")
    else:
        add("- Intra-rater reliability: not measured (optional blind 15% re-code in the Optimize panel)")
    add("")

    # 3. Model and conditions
    add("## 3. Model, settings and environment")
    L.extend(R.conditions_lines(rc))
    add("")

    # 4. Results
    add("## 4. Results")
    points = []
    if not llm and mode != "single_output":
        add("This test has not been run against the model yet.")
    elif bt == "sourceAnalysis":
        pairs = [((human[u].get("detection") or "").upper(), (llm[u].get("detection") or "").upper())
                 for u in human if u in llm and isinstance(human[u], dict) and human[u].get("detection")]
        summ = st.summarize_binary(pairs)
        L.extend(R.binary_table([("Detection (model vs human)", summ)]))
        lab = metrics.get("labels") or {}
        add("")
        add(f"- Label similarity (TF-IDF cosine + Jaccard blend, best pairing per case, both-TRUE cases): "
            f"mean {lab.get('mean_similarity', 'n/a')}/100 over {len(lab.get('per_unit') or {})} case(s)")
        points += R.binary_points(summ)
        points.append("- Labels: similarity is lexical (shared word stems), not semantic equivalence — say so if reporting label agreement")
    elif bt == "rubricAnalysis":
        items = prompts.get("rubric_items") or []
        rm = metrics.get("rubric_scores") or {}
        add("| Rubric item | n | Exact agreement [95% CI] | Within ±1 | Cohen's κ | Weighted κ (linear) | Gwet's AC1 | Model blanks |")
        add("|---|---|---|---|---|---|---|---|")
        for i, item in enumerate(items):
            key = f"rubric_{i + 1}"
            pairs, within, blanks = [], [], 0
            for u, h in human.items():
                hv = (h.get("rubric_scores") or {}).get(key) if isinstance(h, dict) else None
                if hv in (None, "") or u not in llm:
                    continue
                mv = (llm[u].get("rubric_scores") or {}).get(key, "")
                blanks += mv in (None, "")
                pairs.append((str(hv).strip(), str(mv).strip()))
                within.append(1 if scores_within_one(hv, mv) else 0)
            exact = [1 if scores_equal(h_, m_) else 0 for h_, m_ in pairs]
            agr = (sum(exact) / len(exact)) if exact else None
            lo, hi = st.mean_ci(exact)
            w1 = (sum(within) / len(within)) if within else None
            m_ = rm.get(key) or {}
            add(f"| {item.get('title') or key} | {len(pairs)} | {R.pct(agr)} {R.ci([lo, hi])} | {R.pct(w1)} "
                f"| {R.num(m_.get('cohens_kappa'))} | {R.num(m_.get('weighted_kappa'))} | {R.num(st.gwet_ac1(pairs))} | {blanks} |")
            if pairs:
                points.append(f"- {item.get('title') or key}: exact {R.pct(agr)} {R.ci([lo, hi])}, within ±1 {R.pct(w1)}"
                              + (f"; {blanks} model score(s) blank because confidence fell below the label threshold "
                                 "(counted as disagreements)" if blanks else ""))
        add("")
        add("_Model blanks: scores withheld because the model's confidence was below the label threshold._")
        points.append("- For ordinal scores, weighted κ and within-±1 agreement credit near-misses; state which your argument rests on")
    elif mode == "per_unit_theme_match":
        pairs = [(str(human[u].get("theme_choice")), str(llm[u].get("theme_choice"))) for u in human
                 if u in llm and isinstance(human[u], dict) and human[u].get("theme_choice")]
        lo, hi = st.mean_ci([1 if h == m else 0 for h, m in pairs])
        add(f"- Theme assignment agreement: {R.pct(st.raw_agreement(pairs))} {R.ci([lo, hi])} over n = {len(pairs)}; "
            f"Cohen's κ {R.num(st.cohens_kappa(pairs))}; Gwet's AC1 {R.num(st.gwet_ac1(pairs))}")
        points.append("- Theme alignment is an approximation: rows are compared against a frozen theme list, whereas the "
                      "real block builds its list sequentially — state this when reporting")
    elif mode == "single_output":
        so = metrics.get("single_output") or {}
        add(f"- Similarity between the human-expected and the model output: {so.get('similarity', 'n/a')}/100 (lexical TF-IDF/Jaccard)")
        points.append("- A single aggregate comparison: sampling variability cannot be estimated — report as descriptive only")
    add("")

    add("## 5. Reporting points")
    add("Bullet arguments supported by the numbers above, for the author to use, adapt or discard:")
    add("")
    L.extend(points)
    if samp.get("seed") is not None:
        L.append(f"- Reproducibility: sample seed {samp.get('seed')}, model `{rc.get('model', 'n/a')}`, "
                 f"temperature {(rc.get('sampling') or {}).get('temperature', 'n/a')}, exact prompts in §6")
    ps = rc.get("parallel_slots", 1) or 1
    L.append("- Run executed sequentially (one case at a time): supports a replicability claim under the recorded settings"
             if ps == 1 else f"- Run used {ps} parallel cases (batched): do not claim byte-for-byte replicability")
    L.append("- Agreement is with one coder on a sample: it does not establish agreement with other coders or on units unlike those sampled")
    add("")

    add("## 6. Exact prompt structure (appendix material)")
    L.extend(R.skeleton_lines(rc.get("prompt_skeleton"), prompts))
    add("")
    add("## 7. What to report — checklist")
    for item in ("Corpus scope, unit of analysis, sampling frame size, sample size and sampling method/seed (§1)",
                 "Coder(s), coding scheme, rationale practice, intra-rater reliability if measured (§2)",
                 "Model, quantization, decoding settings, thresholds, software and hardware (§3)",
                 "Agreement with CIs; κ with its interpretability flags; prevalence-robust companions (§4)",
                 "Exact prompt text, or a supplementary file containing it (§6)",
                 "Limitations: single rater, sample size, lexical label similarity, replicability conditions"):
        add(f"- [ ] {item}")
    add("")
    add("## References")
    L.extend(R.references_lines())
    return "\n".join(L) + "\n"
