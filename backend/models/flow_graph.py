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
