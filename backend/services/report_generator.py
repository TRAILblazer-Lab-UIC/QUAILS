"""Markdown report builder."""

import os
import json
import csv
from datetime import datetime

from config import (
    PROJECTS_DIR, APP_TITLE, APP_VERSION, APP_VERSION_DATE,
    APP_URL, APP_AUTHOR, APP_LICENSE, APP_LICENSE_URL,
)


def generate_report(project_id):
    """Generate a completed analysis report.

    Returns the path to the generated report file.
    """
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    reports_dir = os.path.join(proj_dir, "reports")
    os.makedirs(reports_dir, exist_ok=True)

    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project = json.load(f)

    date_str = datetime.utcnow().strftime("%m-%d-%Y")
    report_name = f"CompletedAnalysisReport-{date_str}.md"

    # Auto-increment if exists
    counter = 1
    while os.path.exists(os.path.join(reports_dir, report_name)):
        report_name = f"CompletedAnalysisReport-{date_str}-{counter}.md"
        counter += 1

    report_path = os.path.join(reports_dir, report_name)

    sections = [
        f"# QUAILS Analysis Report",
        f"**Project:** {project.get('title', 'Untitled')}",
        f"**Date:** {datetime.utcnow().strftime('%B %d, %Y')}",
        f"**Model:** {os.environ.get('SELECTED_MODEL') or project.get('llm', {}).get('model', 'unknown')}",
        "",
        "## Project Settings",
        f"- Unit type: {project.get('unit_type', 'sentence')}",
        f"- Context window: {project.get('context_window', 1)}",
        f"- Detection threshold: {project.get('thresholds', {}).get('detection', 70)}%",
        f"- Label threshold: {project.get('thresholds', {}).get('label', 70)}%",
        f"- Theme threshold: {project.get('thresholds', {}).get('theme', 80)}%",
        "",
    ]

    # Corpus summary
    inventory_path = os.path.join(proj_dir, "inventory.json")
    if os.path.exists(inventory_path):
        with open(inventory_path, "r", encoding="utf-8") as f:
            inventory = json.load(f)
        sections.append("## Corpus Summary")
        sections.append(f"- Total units: {inventory.get('total_units', 0)}")
        for doc in inventory.get("documents", []):
            sections.append(f"- {doc['filename']}: {doc['unit_count']} {doc.get('unit_type', 'units')}")
        sections.append("")

    # Block results
    blocks_dir = os.path.join(proj_dir, "blocks")
    if os.path.exists(blocks_dir):
        sections.append("## Analysis Results")
        # List blocks in flow order (the order they ran), then any others.
        try:
            from models.flow_graph import FlowGraph
            flow_order = FlowGraph(proj_dir).get_analysis_order()
        except Exception:
            flow_order = []
        present = sorted(os.listdir(blocks_dir))
        ordered = [b for b in flow_order if b in present] + [b for b in present if b not in flow_order]
        for block_name in ordered:
            block_dir = os.path.join(blocks_dir, block_name)
            if not os.path.isdir(block_dir):
                continue

            config_path = os.path.join(block_dir, "config.json")
            config = {}
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            sections.append(f"### Block: {config.get('label', block_name)}")
            sections.append(f"- Block ID: {block_name}")
            inputs = config.get("input_block_ids") or ([config["input_block_id"]] if config.get("input_block_id") else [])
            if inputs:
                sections.append(f"- Input: {', '.join(inputs)}")

            state = _read_json(os.path.join(block_dir, "save_state.json"))
            if state.get("failed"):
                sections.append(f"- Status: FAILED ({state.get('error', 'no detail')})")
            elif state.get("completed"):
                sections.append(f"- Status: complete ({state.get('completed_at', 'time not recorded')})")
            else:
                sections.append("- Status: not complete")
            if state.get("error_units"):
                sections.append(f"- Units with model errors: {len(state['error_units'])}")

            env = _read_json(os.path.join(block_dir, "run_environment.json"))
            if env:
                samp = env.get("sampling", {})
                sections.append(
                    f"- Run conditions: model {env.get('model', '?')}, temperature {samp.get('temperature', '?')}, "
                    f"seed {samp.get('seed', '?')}, context window {samp.get('num_ctx', '?')}, "
                    f"{'sequential (one request at a time)' if env.get('replicable_sequential') else 'parallel requests'}"
                )

            # Summarize CSVs
            for fname in sorted(os.listdir(block_dir)):
                if fname.endswith(".csv"):
                    csv_path = os.path.join(block_dir, fname)
                    row_count = _count_csv_rows(csv_path)
                    sections.append(f"- {fname}: {row_count} rows")

            # Include category reports
            cat_report = os.path.join(block_dir, "categoryReport.md")
            if os.path.exists(cat_report):
                with open(cat_report, "r", encoding="utf-8") as f:
                    sections.append(f.read())

            sections.append("")

    # Human review checkpoints
    reviews = _read_json(os.path.join(proj_dir, "reviews.json"))
    if reviews:
        sections.append("## Human Review Checkpoints")
        for rid, rec in sorted(reviews.items()):
            line = f"- {rid}: approved {rec.get('approved_at', '?')} for block {rec.get('upstream_block_id', '?')} (run of {rec.get('upstream_completed_at', '?')})"
            if rec.get("note"):
                line += f". Note: {rec['note']}"
            sections.append(line)
        sections.append("")

    # Alignment results
    irr_path = os.path.join(proj_dir, "alignment", "irr_history.json")
    if os.path.exists(irr_path):
        with open(irr_path, "r", encoding="utf-8") as f:
            history = json.load(f)
        if history:
            sections.append("## Model Alignment")
            latest = history[-1]
            sections.append(f"- Latest Cohen's κ: {latest.get('kappa', 'N/A')}")
            sections.append(f"- Interpretation: {latest.get('interpretation', 'N/A')}")
            sections.append(f"- Sample size: {latest.get('n', 'N/A')}")
            sections.append("")

    sections.append("---")
    sections.append(f"*Generated by {APP_TITLE} | {APP_URL}*")
    sections.append(f"*Version {APP_VERSION} ({APP_VERSION_DATE}) | Author: {APP_AUTHOR} | License: {APP_LICENSE_URL}*")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sections))

    return report_path


def _count_csv_rows(path):
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.reader(f)
            next(reader, None)  # Skip header
            return sum(1 for _ in reader)
    except Exception:
        return 0


def _read_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}
