"""Block Type 3: Category building - nest themes into categories."""

import os
import json

from config import PROJECTS_DIR, OLLAMA_BASE_URL, SELECTED_MODEL


def run_category_building(project_id, block_id, block_data, model_params=None):
    """Execute category building (Block Type 3).

    Input: themes CSV from Block Type 2
    Output: categoryReport.md with themes nested into N categories
    """
    from services.ollama_client import OllamaClient
    from services.socket_logger import emit_log
    from services.prompt_template_service import get_effective_templates, render_template
    from extensions import socketio
    import csv

    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    block_dir = os.path.join(proj_dir, "blocks", block_id)

    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project = json.load(f)

    mp = model_params or {}
    client = OllamaClient(
        base_url=project.get("llm", {}).get("base_url", OLLAMA_BASE_URL),
        model=os.environ.get("SELECTED_MODEL", SELECTED_MODEL),
        temperature=mp.get("temperature", 0),
        seed=mp.get("seed", 5),
        top_k=mp.get("top_k", 3),
        top_p=mp.get("top_p", 0.9),
        repeat_penalty=mp.get("repeat_penalty", 1.0),
    )

    max_categories = block_data.get("max_categories", project.get("max_categories", 6))

    # Load themes from upstream block
    input_block = block_data.get("input_block_id", "")
    themes_path = ""
    if input_block:
        themes_path = os.path.join(proj_dir, "blocks", input_block, f"{input_block}_themes.csv")

    if not themes_path or not os.path.exists(themes_path):
        emit_log(socketio, f"Themes CSV not found for block {block_id}", "error", project_id)
        return

    themes = []
    with open(themes_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            themes.append(row)

    if not themes:
        emit_log(socketio, "No themes to categorize", "warn", project_id)
        return

    # Build theme summary for LLM
    theme_summary = "\n".join(
        f"- {t['theme_id']}: {t['theme_title']} - {t.get('description', '')}"
        for t in themes
    )

    # Load prompt templates
    templates = get_effective_templates(project_id)
    cb_t = templates.get("categoryBuild", {})
    cat_t = cb_t.get("categorization", {})

    system_content = render_template(
        cat_t.get("systemTemplate", "You are organizing research themes into categories. Create at most {{maxCategories}} categories. For each category, provide a title and list which themes belong to it. Format as markdown."),
        {"maxCategories": max_categories},
    )
    user_content = render_template(
        cat_t.get("userTemplate", "Organize these themes into categories:\n\n{{themeSummary}}"),
        {"themeSummary": theme_summary},
    )

    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content},
    ]

    result = client.chat(messages, temperature=0.3, num_predict=1024)
    if result.get("error"):
        emit_log(socketio, f"Category building error: {result['error']}", "error", project_id)
        return

    report_content = f"# Category Report\n\n{result.get('content', '')}\n"

    report_path = os.path.join(block_dir, "categoryReport.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_content)

    complete_msg = render_template(
        cb_t.get("consoleComplete", "Category report generated with up to {{maxCategories}} categories"),
        {"maxCategories": max_categories},
    )
    emit_log(socketio, complete_msg, "info", project_id)

    from services.version_control import commit_project
    commit_project(proj_dir, f"Block {block_id} category building complete")
