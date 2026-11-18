"""Flow graph model."""

import os
import json


class FlowGraph:
    """Wrapper around a flow.json file."""

    def __init__(self, proj_dir):
        self.proj_dir = proj_dir
        self._data = None

    @property
    def data(self):
        if self._data is None:
            self.load()
        return self._data

    def load(self):
        path = os.path.join(self.proj_dir, "flow.json")
        if not os.path.exists(path):
            self._data = {"nodes": [], "edges": []}
        else:
            with open(path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
        return self._data

    def save(self):
        path = os.path.join(self.proj_dir, "flow.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    @property
    def nodes(self):
        return self.data.get("nodes", [])

    @property
    def edges(self):
        return self.data.get("edges", [])

    def get_analysis_order(self):
        """Return analysis block node IDs in topological order."""
        analysis_types = {"sourceAnalysis", "rubricAnalysis", "themeIdent", "categoryBuild", "customPrompt"}
        analysis_nodes = [n for n in self.nodes if n.get("type") in analysis_types]

        # Build adjacency from edges (skipping human review nodes)
        node_map = {n["id"]: n for n in self.nodes}
        adj = {n["id"]: [] for n in analysis_nodes}

        for edge in self.edges:
            src = edge.get("source")
            tgt = edge.get("target")
            # Skip through human review nodes
            if src in node_map and node_map[src].get("type") == "humanReview":
                # Find the edge leading into this review node
                for e2 in self.edges:
                    if e2.get("target") == src and e2.get("source") in adj:
                        src = e2["source"]
                        break
            if tgt in node_map and node_map[tgt].get("type") == "humanReview":
                # Find the edge leaving this review node
                for e2 in self.edges:
                    if e2.get("source") == tgt and e2.get("target") in adj:
                        tgt = e2["target"]
                        break
            if src in adj and tgt in adj:
                adj[src].append(tgt)

        # Topological sort
        visited = set()
        order = []

        def dfs(node_id):
            if node_id in visited:
                return
            visited.add(node_id)
            for neighbor in adj.get(node_id, []):
                dfs(neighbor)
            order.append(node_id)

        for nid in adj:
            dfs(nid)

        order.reverse()
        return order

    # ── Input resolution and checkpoints ──────────────────────────────────
    ANALYSIS_TYPES = {"sourceAnalysis", "rubricAnalysis", "themeIdent", "categoryBuild", "customPrompt"}
    MULTI_INPUT_TYPES = {"themeIdent"}

    def _node_map(self):
        return {n["id"]: n for n in self.nodes}

    def upstream_links(self, block_id):
        """Return [(upstream_analysis_id, review_id_or_None)] feeding block_id.

        Follows edges backwards. Tee edges carry their review checkpoint in
        ``data.humanReviewId``. Older flows route A → Human Review → B, in
        which case the review node itself is the checkpoint.
        """
        nm = self._node_map()
        links = []
        seen = set()

        def walk(target, review_id):
            for e in self.edges:
                if e.get("target") != target:
                    continue
                src = nm.get(e.get("source"))
                if not src:
                    continue
                rid = review_id or (e.get("data") or {}).get("humanReviewId")
                if src.get("type") in self.ANALYSIS_TYPES:
                    key = (src["id"], rid)
                    if key not in seen:
                        seen.add(key)
                        links.append(key)
                elif src.get("type") == "humanReview" and src["id"] not in seen:
                    seen.add(src["id"])
                    walk(src["id"], rid or src["id"])

        walk(block_id, None)
        return links

    def resolve_block_inputs(self, block_id):
        """Return the upstream analysis block IDs for block_id.

        The flow's edges are the source of truth. Stored input fields are used
        only when the block has no incoming connection at all (older flows).
        """
        node = self._node_map().get(block_id) or {}
        data = node.get("data", {}) or {}
        from_edges = []
        for up, _ in self.upstream_links(block_id):
            if up not in from_edges:
                from_edges.append(up)
        if from_edges:
            return from_edges
        stored = list(data.get("input_block_ids") or [])
        if not stored and data.get("input_block_id"):
            stored = [data["input_block_id"]]
        return [b for b in stored if b in self._node_map()]

    def apply_resolved_inputs(self, block_id, block_data):
        """Return a copy of block_data with input_block_id(s) filled from the flow."""
        node = self._node_map().get(block_id) or {}
        inputs = self.resolve_block_inputs(block_id)
        data = dict(block_data or {})
        if node.get("type") in self.MULTI_INPUT_TYPES:
            data["input_block_ids"] = inputs
        elif inputs:
            data["input_block_id"] = inputs[0]
        return data

    def checkpoints_before(self, block_id):
        """Return [(review_id, upstream_block_id)] that must be approved before block_id runs."""
        return [(rid, up) for up, rid in self.upstream_links(block_id) if rid]

    def review_upstream(self, review_id):
        """Return the upstream analysis block for a review checkpoint."""
        nm = self._node_map()
        for e in self.edges:
            if (e.get("data") or {}).get("humanReviewId") == review_id and e.get("source") in nm:
                return e["source"]
        node = nm.get(review_id) or {}
        if node.get("data", {}).get("upstream_block_id"):
            return node["data"]["upstream_block_id"]
        for e in self.edges:
            if e.get("target") == review_id and nm.get(e.get("source"), {}).get("type") in self.ANALYSIS_TYPES:
                return e["source"]
        return None

    def validate(self):
        """Return a list of human-readable problems that block a run."""
        errors = []
        nm = self._node_map()
        types = [n.get("type", "") for n in self.nodes]
        if "projectSpec" not in types:
            errors.append("Flow must have a Project Spec (start) node")
        if "outputsReport" not in types:
            errors.append("Flow must have an Outputs & Report (end) node")
        for e in self.edges:
            if e.get("source") not in nm:
                errors.append(f"Edge references missing source node: {e.get('source')}")
            if e.get("target") not in nm:
                errors.append(f"Edge references missing target node: {e.get('target')}")
        if not any(t in self.ANALYSIS_TYPES for t in types):
            errors.append("Flow must have at least one analysis block")

        for n in self.nodes:
            t = n.get("type")
            label = (n.get("data") or {}).get("label") or n["id"]
            if t not in ("themeIdent", "categoryBuild"):
                continue
            inputs = self.resolve_block_inputs(n["id"])
            if t == "categoryBuild":
                if not inputs:
                    errors.append(f"{label}: connect a Theme Identification block as its input.")
                for up in inputs:
                    if nm.get(up, {}).get("type") != "themeIdent":
                        up_label = (nm.get(up, {}).get("data") or {}).get("label") or up
                        errors.append(
                            f"{label}: Category Builder needs a Theme Identification block as its input "
                            f"(it is connected to {up_label}). Route open-coding or rubric results "
                            f"through Theme Identification first.")
            if t == "themeIdent":
                if not inputs:
                    errors.append(f"{label}: connect an Open-Coding or Rubric block as its input.")
                for up in inputs:
                    if nm.get(up, {}).get("type") not in ("sourceAnalysis", "rubricAnalysis"):
                        up_label = (nm.get(up, {}).get("data") or {}).get("label") or up
                        errors.append(
                            f"{label}: Theme Identification reads coded units from Open-Coding or Rubric "
                            f"blocks (it is connected to {up_label}).")
        return errors
