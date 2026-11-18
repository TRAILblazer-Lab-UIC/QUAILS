"""Pipeline wiring tests with a stub model (no Ollama needed).

Run from backend/:  python -m unittest tests.test_pipeline -v

Covers every route into the Category Builder:
  (a) template: open coding -> themes -> categories
  (b) rubric -> themes -> categories
  (c) open coding + rubric -> themes -> categories
  (d) a hand-built flow with no stored input_block_id fields
and checks pause-at-checkpoint, approve-and-continue, skipping finished blocks,
loud failures, stale approvals and flow validation.
"""

import io
import os
import sys
import json
import time
import shutil
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="quails-test-")
os.environ["QUAILS_PROJECTS_DIR"] = _TMP
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class FakeClient:
    """Deterministic stand-in for services.ollama_client.OllamaClient."""

    calls = 0

    def __init__(self, base_url=None, model="stub-model", temperature=0, seed=5, top_k=3,
                 top_p=0.9, repeat_penalty=1.0, **_):
        self.base_url, self.model = base_url, model
        self.temperature, self.seed, self.top_k, self.top_p = temperature, seed, top_k, top_p
        self.repeat_penalty, self.num_ctx = repeat_penalty, None

    def warm_model(self):
        return True

    def chat(self, messages, temperature=0.1, num_predict=256, logprobs=True, **_):
        FakeClient.calls += 1
        text = " ".join(m.get("content", "") for m in messages).lower()
        lp = [{"logprob": -0.01}]
        if num_predict >= 1024:
            return {"content": "## Category 1: Visitor experience\n- T001\n- T002", "logprobs": lp}
        if num_predict in (60, 100):
            return {"content": "The unit describes this directly.", "logprobs": lp}
        if num_predict == 5:          # theme comparison
            return {"content": "FALSE", "logprobs": lp}
        if num_predict == 10 and "title" in text:
            return {"content": "Staff and service", "logprobs": lp}
        if num_predict == 10:         # relevance detection
            return {"content": "TRUE", "logprobs": lp}
        if num_predict == 50 and ("rubric" in text or "score" in text):
            return {"content": "3", "logprobs": lp}
        return {"content": "friendly staff", "logprobs": lp}


import services.ollama_client as _oc  # noqa: E402
_oc.OllamaClient = FakeClient

from app import create_app  # noqa: E402

TXT_A = "The staff were friendly. The queue was long.\n\nWe loved the parade. Food was expensive."
TXT_B = "Our guide helped us a lot. The rides were fun.\n\nParking was easy. The map app crashed."
CSV = "review_id,review_text\n1,Great day and fair prices.\n2,Too crowded and pricey.\n3,Wheelchair access was easy.\n"


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        cls.c = cls.app.test_client()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_TMP, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────────────────
    def new_project(self, template="blank"):
        r = self.c.post("/api/projects/", json={"title": "test", "template": template})
        self.assertEqual(r.status_code, 201, r.data)
        return r.get_json()["id"]

    def upload(self, pid, name, content):
        r = self.c.post(f"/api/documents/{pid}/upload",
                        data={"file": (io.BytesIO(content.encode()), name)},
                        content_type="multipart/form-data")
        self.assertIn(r.status_code, (200, 201), r.data)
        self.c.post(f"/api/documents/{pid}/finalize", json={"count": 1})
        return r.get_json()["doc_index"]

    def flow(self, pid):
        return self.c.get(f"/api/flow/{pid}").get_json()

    def put_flow(self, pid, flow):
        r = self.c.put(f"/api/flow/{pid}", json=flow)
        self.assertEqual(r.status_code, 200, r.data)

    def go(self, pid, block_id=None, timeout=60):
        from services import analysis_engine as eng
        body = {"block_id": block_id} if block_id else {}
        r = self.c.post(f"/api/analysis/{pid}/run", json=body)
        self.assertEqual(r.status_code, 200, r.data)
        t0 = time.time()
        while time.time() - t0 < timeout:
            st = eng.get_status(pid)
            if not st.get("active") and st.get("status") not in (None, "running"):
                return st
            time.sleep(0.05)
        self.fail("run timed out")

    def approve(self, pid, review_id, ok=True):
        r = self.c.post(f"/api/analysis/{pid}/reviews/{review_id}/approve", json={"note": "checked"})
        if ok:
            self.assertEqual(r.status_code, 200, r.data)
        return r

    def block_file(self, pid, block_id, name):
        return os.path.join(_TMP, pid, "blocks", block_id, name)

    def reports(self, pid):
        return self.c.get(f"/api/reports/{pid}/list").get_json()

    def run_to_end(self, pid, expected_pauses):
        """Run the pipeline, approving each pause; return the pause review ids."""
        seen = []
        for _ in range(expected_pauses + 1):
            st = self.go(pid)
            self.assertNotEqual(st["status"], "error", st)
            if st["status"] == "paused":
                rid = st["paused"]["review_id"]
                seen.append(rid)
                self.approve(pid, rid)
                continue
            self.assertEqual(st["status"], "complete", st)
            return seen
        self.fail(f"pipeline did not finish; pauses: {seen}")

    def rubric_block(self, doc_index):
        return {
            "label": "Review ratings", "source_type": "single", "source_doc_index": doc_index,
            "unit_type": "line", "selected_columns": ["review_text"],
            "rubric_items": [{"title": "Sentiment", "description": "Overall tone",
                              "scoring_prompt": "Score 1 to 5. Respond with only the number."}],
        }

    def doc_index(self, pid, filename):
        docs = self.c.get(f"/api/documents/{pid}/list").get_json()
        docs = docs.get("documents", docs) if isinstance(docs, dict) else docs
        for d in docs:
            if d.get("filename", "").endswith(filename):
                return d.get("doc_index", d.get("index"))
        self.fail(f"{filename} not found in {docs}")

    # ── tests ────────────────────────────────────────────────────────────
    def test_a_template_route_pauses_and_finishes(self):
        pid = self.new_project("basic_thematic")
        self.upload(pid, "a.txt", TXT_A)
        self.upload(pid, "b.txt", TXT_B)
        cat = next(n for n in self.flow(pid)["nodes"] if n["id"] == "categoryBuild_1")
        self.assertEqual(cat["data"].get("input_block_id"), "themeIdent_1")

        pauses = self.run_to_end(pid, expected_pauses=2)
        self.assertEqual(pauses, ["review_1", "review_2"])
        self.assertTrue(os.path.exists(self.block_file(pid, "categoryBuild_1", "categoryReport.md")))
        self.assertTrue(os.path.exists(self.block_file(pid, "categoryBuild_1", "run_environment.json")))
        reps = self.reports(pid)
        self.assertEqual(len(reps), 1)
        report = open(os.path.join(_TMP, pid, "reports", reps[0]), encoding="utf-8").read()
        self.assertIn("Human Review Checkpoints", report)
        self.assertIn("Status: complete", report)

        # A second pipeline run skips every finished block and only writes a new report.
        before = FakeClient.calls
        st = self.go(pid)
        self.assertEqual(st["status"], "complete")
        self.assertEqual(FakeClient.calls, before)

    def test_b_rubric_route(self):
        pid = self.new_project()
        di = self.upload(pid, "reviews.csv", CSV)
        flow = self.manual_flow(["rubric"], rubric_doc=di)
        self.put_flow(pid, flow)
        self.run_to_end(pid, expected_pauses=2)
        self.assertTrue(os.path.exists(self.block_file(pid, "cat", "categoryReport.md")))
        themes = open(self.block_file(pid, "themes", "themes_themes.csv"), encoding="utf-8").read()
        self.assertIn("Staff and service", themes)

    def test_c_open_and_rubric_route(self):
        pid = self.new_project()
        ai = self.upload(pid, "a.txt", TXT_A)
        di = self.upload(pid, "reviews.csv", CSV)
        flow = self.manual_flow(["open", "rubric"], rubric_doc=di, open_doc=ai)
        self.put_flow(pid, flow)
        self.run_to_end(pid, expected_pauses=3)
        cfg = json.load(open(self.block_file(pid, "themes", "config.json"), encoding="utf-8"))
        self.assertEqual(sorted(cfg["input_block_ids"]), ["open", "rubric"])
        self.assertTrue(os.path.exists(self.block_file(pid, "cat", "categoryReport.md")))

    def test_d_handbuilt_flow_without_stored_inputs(self):
        pid = self.new_project()
        self.upload(pid, "a.txt", TXT_A)
        flow = self.manual_flow(["open"], strip_inputs=True)
        self.put_flow(pid, flow)
        self.run_to_end(pid, expected_pauses=2)
        cfg = json.load(open(self.block_file(pid, "cat", "config.json"), encoding="utf-8"))
        self.assertEqual(cfg["input_block_id"], "themes")

    def test_e_failure_stops_the_run(self):
        pid = self.new_project("basic_thematic")
        self.upload(pid, "a.txt", TXT_A)
        self.run_to_end(pid, expected_pauses=2)
        # Remove the themes file and run the Category Builder alone: it must fail loudly.
        os.remove(self.block_file(pid, "themeIdent_1", "themeIdent_1_themes.csv"))
        st = self.go(pid, "categoryBuild_1")
        self.assertEqual(st["status"], "error")
        self.assertIn("Theme Identification", st["error"])
        state = self.c.get(f"/api/analysis/{pid}/block-state/categoryBuild_1").get_json()
        self.assertTrue(state["failed"])
        self.assertFalse(state["is_complete"])

    def test_f_rerun_makes_approval_outdated(self):
        pid = self.new_project("basic_thematic")
        self.upload(pid, "a.txt", TXT_A)
        self.run_to_end(pid, expected_pauses=2)
        reviews = self.c.get(f"/api/analysis/{pid}/reviews").get_json()
        self.assertEqual(reviews["review_1"]["status"], "approved")
        # Re-run the open-coding block on its own: its downstream approval becomes outdated.
        self.c.post(f"/api/analysis/{pid}/block-clear/sourceAnalysis_1")
        self.go(pid, "sourceAnalysis_1")
        reviews = self.c.get(f"/api/analysis/{pid}/reviews").get_json()
        self.assertEqual(reviews["review_1"]["status"], "outdated")
        # The next pipeline run pauses at the outdated checkpoint before re-running themes.
        st = self.go(pid)
        self.assertEqual(st["status"], "paused")
        self.assertEqual(st["paused"]["review_id"], "review_1")
        # Approving before the upstream block has run is refused.
        pid2 = self.new_project("basic_thematic")
        r = self.approve(pid2, "review_1", ok=False)
        self.assertEqual(r.status_code, 400)

    def test_g_validation_rejects_wrong_category_inputs(self):
        for kind in ("open", "rubric", "custom"):
            pid = self.new_project()
            flow = self.manual_flow([kind], cat_direct=True)
            self.put_flow(pid, flow)
            errs = self.c.post(f"/api/flow/{pid}/validate").get_json()["errors"]
            self.assertTrue(any("Category Builder needs a Theme Identification block" in e for e in errs), errs)
            st = self.go(pid)
            self.assertEqual(st["status"], "error")

    # ── flow builder for hand-made flows ─────────────────────────────────
    def manual_flow(self, sources, rubric_doc=None, open_doc=None, strip_inputs=False, cat_direct=False):
        nodes = [
            {"id": "spec", "type": "projectSpec", "position": {"x": 0, "y": 0},
             "data": {"label": "Project Spec", "temperature": 0, "seed": 5}},
            {"id": "end", "type": "outputsReport", "position": {"x": 0, "y": 900}, "data": {"label": "Outputs & Report"}},
        ]
        edges = []
        src_ids = []
        for kind in sources:
            if kind == "open":
                data = {"label": "Open coding", "detection_prompt": "Is this about the visit? TRUE or FALSE.",
                        "label_prompt": "Label it."}
                if open_doc is not None:
                    data.update({"source_type": "single", "source_doc_index": open_doc})
                nodes.append({"id": "open", "type": "sourceAnalysis", "position": {"x": 0, "y": 100}, "data": data})
                src_ids.append("open")
            elif kind == "rubric":
                nodes.append({"id": "rubric", "type": "rubricAnalysis", "position": {"x": 300, "y": 100},
                              "data": self.rubric_block(rubric_doc if rubric_doc is not None else 0)})
                src_ids.append("rubric")
            elif kind == "custom":
                nodes.append({"id": "custom", "type": "customPrompt", "position": {"x": 600, "y": 100},
                              "data": {"label": "Custom", "prompt": "Summarize."}})
                src_ids.append("custom")
        for s in src_ids:
            edges.append({"id": f"e-spec-{s}", "source": "spec", "target": s, "type": "custom"})
        nodes.append({"id": "cat", "type": "categoryBuild", "position": {"x": 0, "y": 700},
                      "data": {"label": "Categories", "max_categories": 3}})
        if cat_direct:
            for s in src_ids:
                edges.append({"id": f"e-{s}-cat", "source": s, "target": "cat", "type": "custom"})
            edges.append({"id": "e-cat-end", "source": "cat", "target": "end", "type": "custom"})
            return {"nodes": nodes, "edges": edges}
        theme_data = {"label": "Themes"}
        if not strip_inputs:
            theme_data["input_block_ids"] = list(src_ids)
            nodes[-1]["data"]["input_block_id"] = "themes"
        nodes.append({"id": "themes", "type": "themeIdent", "position": {"x": 0, "y": 400}, "data": theme_data})
        for i, s in enumerate(src_ids):
            rid = f"rev_{s}"
            nodes.append({"id": rid, "type": "humanReview", "position": {"x": 300, "y": 300 + i * 40},
                          "data": {"label": "Human Review", "upstream_block_id": s}})
            edges.append({"id": f"e-{s}-themes", "source": s, "target": "themes", "type": "tee",
                          "data": {"humanReviewId": rid}})
        nodes.append({"id": "rev_themes", "type": "humanReview", "position": {"x": 300, "y": 600},
                      "data": {"label": "Human Review", "upstream_block_id": "themes"}})
        edges.append({"id": "e-themes-cat", "source": "themes", "target": "cat", "type": "tee",
                      "data": {"humanReviewId": "rev_themes"}})
        edges.append({"id": "e-cat-end", "source": "cat", "target": "end", "type": "custom"})
        return {"nodes": nodes, "edges": edges}


if __name__ == "__main__":
    unittest.main(verbosity=2)
