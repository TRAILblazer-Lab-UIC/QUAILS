"""Prompt template service — loads, saves, merges, and renders LLM prompt templates.

Global defaults live in backend/data/prompt_defaults.json.
Per-project overrides live in projects/{id}/prompt_overrides.json.
get_effective_templates() deep-merges them so project overrides win only for keys
they explicitly set; everything else falls through to global defaults.
"""

import json
import os
import re

from config import PROJECTS_DIR

DEFAULT_TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "prompt_defaults.json")


# ---------------------------------------------------------------------------
# Hardcoded Python fallback (used when prompt_defaults.json is missing)
# ---------------------------------------------------------------------------
_FALLBACK: dict = {
    "sourceAnalysis": {
        "detection": {
            "systemTemplate": "{{blockPrompt}}",
            "unitIntro": "The following is a {{unitType}} from the research dataset to be analyzed:",
            "contextPreTemplate": "Here is text that appeared before this unit to provide context:\n{{preContext}}\n",
            "contextPostTemplate": "\nHere is text that appeared after this unit to provide context:\n{{postContext}}",
            "reasoningPrompt": "Provide your reasoning for this response in fewer than {{reasoningWords}} words.",
            "reasoningWords": 20,
        },
        "labeling": {
            "reasoningPrompt": "Provide your reasoning for giving this label in fewer than {{reasoningWords}} words.",
            "reasoningWords": 20,
        },
        "consoleHeader": (
            "── Detection prompt ──────────────────────────────\n{{detectionPrompt}}\n"
            "── Label prompt ──────────────────────────────────\n{{labelPrompt}}\n"
            "── Settings ──────────────────────────────────────\n"
            "Model: {{model}}\n"
            "temperature={{temperature}} | seed={{seed}} | top_k={{topK}} | top_p={{topP}} | repeat_penalty={{repeatPenalty}}\n"
            "Unit type: {{unitType}} | Detection threshold: {{detectionThreshold}}% | Label threshold: {{labelThreshold}}%\n"
            "Total units: {{totalUnits}} | Starting at: {{startIndex}}\n"
            "─────────────────────────────────────────────────"
        ),
        "consoleUnit": '[{{verdict}}] {{unitId}} — "{{snippet}}..." → {{label}} (conf: {{confidence}}%) | {{reasoning}}',
    },
    "rubricAnalysis": {
        "scoring": {
            "systemTemplate": "Rubric item: {{rubricTitle}}\n\nDescription: {{rubricDescription}}\n\n{{blockPrompt}}",
            "unitIntro": "The following is a {{unitType}} from the research dataset to be scored:",
            "contextPreTemplate": "Here is text that appeared before this unit to provide context:\n{{preContext}}\n",
            "contextPostTemplate": "\nHere is text that appeared after this unit to provide context:\n{{postContext}}",
        },
        "consoleHeader": (
            "── Rubric Analysis ───────────────────────────────\n"
            "Model: {{model}}\n"
            "temperature={{temperature}} | seed={{seed}} | top_k={{topK}} | top_p={{topP}} | repeat_penalty={{repeatPenalty}}\n"
            "Unit type: {{unitType}} | Rubric items: {{rubricCount}} | Label threshold: {{labelThreshold}}%\n"
            "Total units: {{totalUnits}} | Starting at: {{startIndex}}\n"
            "─────────────────────────────────────────────────"
        ),
        "consoleUnit": "[RUBRIC] {{unitId}} — rubric_{{rubricIndex}}: {{score}} (conf: {{confidence}}%) | {{justification}}",
    },
    "themeIdent": {
        "themeComparison": {
            "systemTemplate": "You are evaluating whether a label belongs to a theme. Respond with only TRUE or FALSE.",
            "userTemplate": "Label: {{label}}\nRationale: {{reasoning}}\n\nTheme: {{themeTitle}}\nDescription: {{themeDescription}}\n\nIs this label related to this theme?",
        },
        "titleGeneration": {
            "systemTemplate": "Generate a 1-2 word theme title for this label. Respond with only the theme title.",
            "userTemplate": "Label: {{label}}\nRationale: {{reasoning}}",
        },
        "consoleUnit": "[THEME] row {{rowNum}} → {{themeId}}: {{themeTitle}}",
    },
    "categoryBuild": {
        "categorization": {
            "systemTemplate": "You are organizing research themes into categories. Create at most {{maxCategories}} categories. For each category, provide a title and list which themes belong to it. Format as markdown.",
            "userTemplate": "Organize these themes into categories:\n\n{{themeSummary}}",
        },
        "consoleComplete": "Category report generated with up to {{maxCategories}} categories",
    },
    "customPrompt": {
        "execution": {
            "systemTemplate": "{{blockPrompt}}",
            "userTemplate": "{{inputData}}",
        },
        "consoleComplete": "Custom prompt block {{blockId}} complete",
    },
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_global_defaults() -> dict:
    """Read prompt_defaults.json; return {} on missing or parse error."""
    path = os.path.normpath(DEFAULT_TEMPLATES_PATH)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_global_defaults(data: dict) -> None:
    """Write data to prompt_defaults.json, creating data/ if needed."""
    path = os.path.normpath(DEFAULT_TEMPLATES_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_project_overrides(project_id: str) -> dict:
    """Read projects/{id}/prompt_overrides.json; return {} on missing."""
    path = _overrides_path(project_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_project_overrides(project_id: str, data: dict) -> None:
    """Write data to projects/{id}/prompt_overrides.json."""
    path = _overrides_path(project_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def delete_project_overrides(project_id: str) -> None:
    """Delete prompt_overrides.json if it exists."""
    path = _overrides_path(project_id)
    if os.path.exists(path):
        os.remove(path)


def get_effective_templates(project_id: str) -> dict:
    """Deep-merge global defaults + project overrides.

    Priority: project overrides > global defaults > hardcoded fallback.
    """
    base = _deep_merge(_FALLBACK, load_global_defaults())
    overrides = load_project_overrides(project_id)
    return _deep_merge(base, overrides)


def render_template(template_str: str, variables: dict) -> str:
    """Replace {{key}} placeholders with values from variables dict.

    Unknown placeholders are left unchanged.
    """
    def replacer(match):
        key = match.group(1)
        val = variables.get(key)
        if val is None:
            return match.group(0)  # leave placeholder intact
        return str(val)

    return re.sub(r"\{\{(\w+)\}\}", replacer, template_str)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _overrides_path(project_id: str) -> str:
    return os.path.join(PROJECTS_DIR, project_id, "prompt_overrides.json")


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into a copy of base.

    For dict values, recurse. For scalar/list values, override wins.
    """
    result = dict(base)
    for key, val in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = _deep_merge(result[key], val)
        else:
            result[key] = val
    return result
