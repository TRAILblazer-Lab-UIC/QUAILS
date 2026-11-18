"""Block Type 4: User-defined custom prompt block."""

import os
import json

from config import PROJECTS_DIR, OLLAMA_BASE_URL, SELECTED_MODEL


def run_custom_prompt(project_id, block_id, block_data, model_params=None):
    """Execute a custom prompt block (Block Type 4).

    Generic block: user defines input source, output format, and custom LLM prompt.
    """
    from services.ollama_client import OllamaClient
    from services.socket_logger import emit_log
    from services.prompt_template_service import get_effective_templates, render_template
    from extensions import socketio

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

    custom_prompt = block_data.get("prompt", "")
    input_source = block_data.get("input_source", "")
    output_format = block_data.get("output_format", "markdown")

    if not custom_prompt:
        from services.pipeline import BlockFailed
        raise BlockFailed("No prompt is set. Write the prompt in the block settings.")

    # Load input data
    input_text = ""
    if input_source and os.path.exists(input_source):
        with open(input_source, "r", encoding="utf-8") as f:
            input_text = f.read()
    elif block_data.get("input_block_id"):
        # Try to load from upstream block
        input_block = block_data["input_block_id"]
        input_dir = os.path.join(proj_dir, "blocks", input_block)
        if os.path.exists(input_dir):
            for fname in os.listdir(input_dir):
                if fname.endswith(".csv") or fname.endswith(".md"):
                    with open(os.path.join(input_dir, fname), "r", encoding="utf-8") as f:
                        input_text += f"\n--- {fname} ---\n{f.read()}"

    # Load prompt templates
    templates = get_effective_templates(project_id)
    cp = templates.get("customPrompt", {})
    exec_t = cp.get("execution", {})

    system_content = render_template(
        exec_t.get("systemTemplate", "{{blockPrompt}}"),
        {"blockPrompt": custom_prompt},
    )
    user_content = render_template(
        exec_t.get("userTemplate", "{{inputData}}"),
        {"inputData": input_text or "No input data provided."},
    )

    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content},
    ]

    from services.llm_utils import write_run_environment
    write_run_environment(block_dir, client, 1)
    result = client.chat(messages, temperature=0.3, num_predict=2048)
    if result.get("error"):
        from services.pipeline import BlockFailed
        raise BlockFailed(f"The model returned an error: {result['error']}")

    content = result.get("content", "")

    if output_format == "markdown":
        output_path = os.path.join(block_dir, f"{block_id}_output.md")
    else:
        output_path = os.path.join(block_dir, f"{block_id}_output.txt")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)

    complete_msg = render_template(
        cp.get("consoleComplete", "Custom prompt block {{blockId}} complete"),
        {"blockId": block_id},
    )
    emit_log(socketio, complete_msg, "info", project_id)

    from services.version_control import commit_project
    commit_project(proj_dir, f"Block {block_id} custom prompt complete")
