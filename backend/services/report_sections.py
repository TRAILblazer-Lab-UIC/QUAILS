"""Shared building blocks for QUAILS write-up reports (alignment + optimization).

Reports give the author *facts, tables and reporting points* — bullet-point
arguments and the numbers behind them — never drafted manuscript prose.
"""

NOT_RECORDED = "not recorded (this run predates run-condition snapshots)"

REFERENCES = [
    "Byrt, T., Bishop, J., & Carlin, J. B. (1993). Bias, prevalence and kappa. Journal of Clinical Epidemiology, 46(5), 423–429.",
    "Cohen, J. (1960). A coefficient of agreement for nominal scales. Educational and Psychological Measurement, 20(1), 37–46.",
    "Cohen, J. (1968). Weighted kappa: Nominal scale agreement with provision for scaled disagreement or partial credit. Psychological Bulletin, 70(4), 213–220.",
    "Efron, B. (1979). Bootstrap methods: Another look at the jackknife. The Annals of Statistics, 7(1), 1–26.",
    "Gwet, K. L. (2008). Computing inter-rater reliability and its variance in the presence of high agreement. British Journal of Mathematical and Statistical Psychology, 61(1), 29–48.",
    "Landis, J. R., & Koch, G. G. (1977). The measurement of observer agreement for categorical data. Biometrics, 33(1), 159–174.",
]


def pct(v, d=1):
    return "n/a" if v is None else f"{v * 100:.{d}f}%"


def num(v, d=3):
    return "n/a" if v is None else f"{v:.{d}f}"


def ci(c, scale=100, d=1):
    if not c or c[0] is None:
        return "n/a"
    return f"[{c[0] * scale:.{d}f}, {c[1] * scale:.{d}f}]"


def pp(v):
    return "n/a" if v is None else f"{v * 100:+.1f} pp"


def fence(t):
    return "```text\n" + (t or "").replace("```", "'''") + "\n```"


# ---------------------------------------------------------------------------
# Conditions / configuration
# ---------------------------------------------------------------------------

def conditions_lines(rc):
    if not rc or rc.get("error"):
        return [f"- {(rc or {}).get('error') or NOT_RECORDED}"]
    s, o, sysi = rc.get("sampling", {}), rc.get("ollama", {}), rc.get("system", {})
    md = o.get("model_details") or {}
    L = [
        f"- Model: `{rc.get('model')}`" + (f" — family {md.get('family')}, {md.get('parameter_size')} parameters, {md.get('quantization_level')} quantization, {md.get('format')}" if md else "")
        + f"; served locally by Ollama {o.get('version') or '(version unknown)'} ({rc.get('provider')})",
        f"- Decoding: temperature {s.get('temperature')}, seed {s.get('seed')}, top_k {s.get('top_k')}, top_p {s.get('top_p')}, "
        f"repeat penalty {s.get('repeat_penalty')}, context window "
        + (f"{s.get('num_ctx'):,} tokens" if isinstance(s.get('num_ctx'), int) else f"{s.get('num_ctx')} (2,048 tokens)")
        + ", reasoning/thinking tokens disabled",
    ]
    th = rc.get("thresholds") or {}
    if th:
        L.append("- Confidence thresholds: " + ", ".join(f"{k.replace('_', ' ')} {v}%" for k, v in th.items())
                 + " (confidence = e^(token log-probability) × 100)")
    L.append(f"- Software: QUAILS {rc.get('quails_version')}; Python {sysi.get('python')}")
    L.append(f"- Hardware: {sysi.get('os')} ({sysi.get('machine')}), {sysi.get('cpu_count')} CPU cores, {sysi.get('ram_gb')} GB RAM")
    ex = rc.get("execution") or {}
    acc = ex.get("accelerator") or {}
    if acc:
        L.append(f"- Accelerator: {acc.get('gpu_name') or acc.get('chip')} ({acc.get('kind')}"
                 + (f", unified memory, ≈{acc.get('gpu_budget_gb')} GB GPU-addressable" if acc.get("unified_memory") else "") + ")")
    res = ex.get("gpu_residency")
    if res:
        L.append(f"- Model residency during the run: {round((res.get('gpu_fraction') or 0) * 100)}% in GPU memory")
    srv = ex.get("ollama_server") or {}
    if srv:
        st = srv.get("settings") or {}
        L.append(f"- Ollama server settings ({srv.get('settings_source')}): " + (", ".join(f"{k}={v}" for k, v in st.items()) or "Ollama defaults"))
    ps = rc.get("parallel_slots", ex.get("parallel_slots", 1)) or 1
    L.append(f"- Execution: {'sequential, one case at a time' if ps == 1 else f'{ps} cases in parallel (batched; not byte-for-byte replicable vs. sequential)'}")
    L.append(f"- Run recorded: {rc.get('recorded_at')}")
    return L


def skeleton_lines(skeleton, prompts=None):
    L = ["Exact message sequence sent to the model for every case; `[BRACKETS]` mark where case content is inserted.", ""]
    if skeleton:
        for step in skeleton:
            L.append(f"#### {step.get('name')}")
            L.append(f"_Max output tokens: {step.get('max_tokens')}_")
            for m in step.get("messages", []):
                L.append(f"**{m['role'].upper()}**")
                L.append(fence(m["content"]))
            L.append("")
        return L
    L.append(f"Rendered structure {NOT_RECORDED}. Block prompts used:")
    prompts = prompts or {}
    for key in ("detection_prompt", "label_prompt", "prompt"):
        if prompts.get(key):
            L += [f"**{key}**", fence(prompts[key])]
    for i, item in enumerate(prompts.get("rubric_items") or []):
        L += [f"**Rubric item {i + 1}: {item.get('title', '')}**",
              fence(f"Description: {item.get('description', '')}\n\n{item.get('scoring_prompt', '')}")]
    return L


# ---------------------------------------------------------------------------
# Statistics tables + reporting points
# ---------------------------------------------------------------------------

def binary_table(summaries):
    """summaries: list of (column_label, summarize_binary dict)."""
    cols = [c for c, _ in summaries]
    rows = [
        ("n (cases)", lambda s: str(s["n"])),
        ("2×2 cells a / b / c / d", lambda s: "{a} / {b} / {c} / {d}".format(**s["cells"])),
        ("Observed agreement [95% CI]", lambda s: f"{pct(s['agreement'])} {ci(s.get('agreement_ci'))}"),
        ("Cohen's κ [95% CI]", lambda s: f"{num(s['kappa'])} {ci(s.get('kappa_ci'), 1, 3)}"),
        ("Gwet's AC1", lambda s: num(s["ac1"])),
        ("PABAK", lambda s: num(s["pabak"])),
        ("Missed-TRUE rate b/(a+b)", lambda s: pct(s["missed_positive_rate"])),
        ("False-TRUE rate c/(c+d)", lambda s: pct(s["false_positive_rate"])),
        ("Prevalence index", lambda s: num(s["prevalence_index"])),
        ("Bias index", lambda s: num(s["bias_index"])),
        ("κ decision-grade / interpretable", lambda s: f"{'yes' if s['kappa_decision_grade'] else 'no'} / {'yes' if s['kappa_interpretable'] else 'no'}"),
    ]
    L = ["| Statistic | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    for name, fn in rows:
        L.append(f"| {name} | " + " | ".join(fn(s) for _, s in summaries) + " |")
    L.append("")
    L.append("_a = both TRUE, b = human TRUE / model FALSE, c = human FALSE / model TRUE, d = both FALSE._")
    return L


def binary_points(s, what="detection"):
    """Bullet-point arguments the numbers support (for the author to use)."""
    P = []
    if not s or not s.get("n"):
        return ["- No paired cases to report."]
    a, b, c, d = s["cells"]["a"], s["cells"]["b"], s["cells"]["c"], s["cells"]["d"]
    n = s["n"]
    P.append(f"- {what.capitalize()} agreement {pct(s['agreement'])} on n = {n} {ci(s.get('agreement_ci'))}; human coded TRUE in {a + b}/{n} ({pct((a + b) / n)}) cases, model in {a + c}/{n} ({pct((a + c) / n)})")
    lo, hi = (s.get("agreement_ci") or [None, None])
    if lo is not None:
        P.append(f"- Precision: the agreement CI spans {(hi - lo) * 100:.0f} points — differences smaller than this between prompts/models are not distinguishable at this n")
    if not s["kappa_interpretable"]:
        P.append(f"- Prevalence index {num(s['prevalence_index'], 2)} > 0.70: κ is depressed by the skewed marginal (kappa paradox) — argue agreement with AC1 ({num(s['ac1'], 2)}) and PABAK ({num(s['pabak'], 2)}) and report κ for continuity only")
    elif s["cells"]["a"] + s["cells"]["c"] in (0, n) or s["cells"]["a"] + s["cells"]["b"] in (0, n):
        P.append("- One rater (human or model) used a single category throughout: κ is 0 by construction and uninformative — report raw agreement and the error profile instead")
    elif not s["kappa_decision_grade"]:
        P.append("- κ interval too wide (or too many single-category resamples) to attach a verbal band (e.g. Landis & Koch); report the interval, not a label")
    else:
        P.append(f"- κ = {num(s['kappa'], 2)} {ci(s.get('kappa_ci'), 1, 2)} is precise and interpretable at this prevalence; AC1 {num(s['ac1'], 2)} as a prevalence-robust companion")
    if b + c:
        direction = "under-codes (misses instances the human coded)" if b > c else "over-codes (flags instances the human did not)" if c > b else "errs symmetrically"
        P.append(f"- Error profile: {b} missed vs {c} false TRUE (bias index {num(s['bias_index'], 2)}) — the model {direction}; state which error is costlier for your research question")
    P.append(f"- Missed-TRUE rate {pct(s['missed_positive_rate'])}: the share of human-identified instances the model would drop from analysis")
    return P


def references_lines():
    return [f"- {r}" for r in REFERENCES]
