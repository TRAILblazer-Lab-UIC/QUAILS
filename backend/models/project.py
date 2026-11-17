"""Project data model (JSON-backed)."""

import os
import json


class Project:
    """Wrapper around a project.json file."""

    def __init__(self, project_id, projects_dir):
        self.project_id = project_id
        self.proj_dir = os.path.join(projects_dir, project_id)
        self._data = None

    @property
    def data(self):
        if self._data is None:
            self.load()
        return self._data

    def load(self):
        path = os.path.join(self.proj_dir, "project.json")
        with open(path, "r", encoding="utf-8") as f:
            self._data = json.load(f)
        return self._data

    def save(self):
        path = os.path.join(self.proj_dir, "project.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    @property
    def short_id(self):
        return self.project_id[:4]

    @property
    def model(self):
        return self.data.get("llm", {}).get("model", "gemma3")

    @property
    def unit_type(self):
        return self.data.get("unit_type", "sentence")

    @property
    def context_window(self):
        return self.data.get("context_window", 1)
