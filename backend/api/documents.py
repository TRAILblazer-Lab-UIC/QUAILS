"""Document upload, parse, and serve endpoints."""

import os
import json
from flask import Blueprint, request, jsonify, send_from_directory

from config import PROJECTS_DIR

documents_bp = Blueprint("documents", __name__)


@documents_bp.route("/<project_id>/upload", methods=["POST"])
def upload_document(project_id):
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    folder_name = request.form.get("folder_name") or None
    batch = request.form.get("batch") == "true"

    corpus_dir = os.path.join(proj_dir, "corpus")
    filepath = os.path.join(corpus_dir, file.filename)
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    file.save(filepath)

    # Parse will be implemented in Phase 2
    from services.document_parser import parse_document
    from services.unit_manager import build_units
    from services.version_control import commit_project

    parsed = parse_document(filepath)
    if parsed is None:
        return jsonify({"error": "Failed to parse document"}), 400

    # Load project for unit type config
    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project = json.load(f)

    doc_index = _next_doc_index(proj_dir)
    project_short = project["id"][:4]
    unit_type = project.get("unit_type", "sentence")
    context_window = project.get("context_window", 1)

    # Tabular formats must always use line-based segmentation so each
    # spreadsheet row becomes exactly one unit.
    if parsed.get("format") in ("csv", "xlsx", "xls", "numbers"):
        unit_type = "line"

    units = build_units(parsed, project_short, doc_index, unit_type, context_window)

    from services.segmenter import extract_structure
    structure = extract_structure(parsed)

    parsed_path = os.path.join(proj_dir, "parsed", f"doc_{doc_index:03d}.json")
    doc_json = {
        "filename": file.filename,
        "doc_index": doc_index,
        "unit_type": unit_type,
        "format": parsed.get("format"),
        "folder_name": folder_name,
        "structure": {
            "section_count": len(structure["sections"]),
            "para_count": sum(len(s["paragraphs"]) for s in structure["sections"]),
        },
        "units": [u.to_dict() for u in units],
    }
    if parsed.get("columns"):
        doc_json["columns"] = parsed["columns"]
    if parsed.get("has_tables"):
        doc_json["has_tables"] = True
    with open(parsed_path, "w", encoding="utf-8") as f:
        json.dump(doc_json, f, indent=2)

    if folder_name:
        _update_folders(proj_dir, folder_name, doc_index)

    # In batch mode the caller will finalize once at the end — skip the
    # per-file inventory rebuild and git commit (O(n²) for large folders).
    if not batch:
        _update_inventory(proj_dir)
        commit_project(proj_dir, f"Document uploaded: {file.filename}")

    return jsonify({
        "filename": file.filename,
        "doc_index": doc_index,
        "unit_count": len(units),
    }), 201


@documents_bp.route("/<project_id>/finalize", methods=["POST"])
def finalize_upload(project_id):
    """Called once after a batch upload to rebuild inventory and commit."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json(silent=True) or {}
    count = data.get("count", 0)

    _update_inventory(proj_dir)

    from services.version_control import commit_project
    commit_project(proj_dir, f"Batch upload: {count} document(s)")

    parsed_dir = os.path.join(proj_dir, "parsed")
    actual_count = 0
    if os.path.exists(parsed_dir):
        actual_count = len([f for f in os.listdir(parsed_dir) if f.endswith(".json")])

    return jsonify({"status": "ok", "document_count": actual_count})


@documents_bp.route("/<project_id>/list", methods=["GET"])
def list_documents(project_id):
    parsed_dir = os.path.join(PROJECTS_DIR, project_id, "parsed")
    if not os.path.exists(parsed_dir):
        return jsonify([])

    docs = []
    for fname in sorted(os.listdir(parsed_dir)):
        if fname.endswith(".json"):
            with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f:
                data = json.load(f)
                docs.append({
                    "filename": data["filename"],
                    "doc_index": data["doc_index"],
                    "unit_count": len(data.get("units", [])),
                    "unit_type": data.get("unit_type", "sentence"),
                    "folder_name": data.get("folder_name"),
                })
    return jsonify(docs)


@documents_bp.route("/<project_id>/folders", methods=["GET"])
def list_folders(project_id):
    folders_path = os.path.join(PROJECTS_DIR, project_id, "folders.json")
    if not os.path.exists(folders_path):
        return jsonify({"folders": []})
    with open(folders_path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@documents_bp.route("/<project_id>/parsed/<int:doc_index>", methods=["GET"])
def get_parsed(project_id, doc_index):
    parsed_path = os.path.join(PROJECTS_DIR, project_id, "parsed", f"doc_{doc_index:03d}.json")
    if not os.path.exists(parsed_path):
        return jsonify({"error": "Parsed document not found"}), 404
    with open(parsed_path, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@documents_bp.route("/<project_id>/serve/<path:filename>", methods=["GET"])
def serve_document(project_id, filename):
    corpus_dir = os.path.join(PROJECTS_DIR, project_id, "corpus")
    return send_from_directory(corpus_dir, filename)


@documents_bp.route("/<project_id>/columns", methods=["GET"])
def get_columns(project_id):
    """Return union of all column names across tabular documents."""
    parsed_dir = os.path.join(PROJECTS_DIR, project_id, "parsed")
    if not os.path.exists(parsed_dir):
        return jsonify({"columns": [], "has_tabular": False})

    seen = set()
    columns = []
    has_tabular = False
    for fname in sorted(os.listdir(parsed_dir)):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f:
            data = json.load(f)
        doc_cols = data.get("columns")
        if doc_cols:
            has_tabular = True
            for col in doc_cols:
                if col not in seen:
                    seen.add(col)
                    columns.append(col)

    return jsonify({"columns": columns, "has_tabular": has_tabular})


@documents_bp.route("/<project_id>/folder/<path:folder_name>", methods=["DELETE"])
def delete_folder(project_id, folder_name):
    """Delete all documents belonging to a folder collection."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    folders_path = os.path.join(proj_dir, "folders.json")
    if not os.path.exists(folders_path):
        return jsonify({"error": "Folder not found"}), 404

    with open(folders_path, "r", encoding="utf-8") as f:
        folders_data = json.load(f)

    folder_entry = next(
        (e for e in folders_data["folders"] if e["folder_name"] == folder_name), None
    )
    if not folder_entry:
        return jsonify({"error": "Folder not found"}), 404

    corpus_dir = os.path.join(proj_dir, "corpus")
    parsed_dir = os.path.join(proj_dir, "parsed")
    deleted_files = []

    for doc_index in folder_entry["doc_indices"]:
        parsed_path = os.path.join(parsed_dir, f"doc_{doc_index:03d}.json")
        if not os.path.exists(parsed_path):
            continue
        with open(parsed_path, "r", encoding="utf-8") as f:
            doc_data = json.load(f)
        corpus_path = os.path.join(corpus_dir, doc_data["filename"])
        if os.path.exists(corpus_path):
            os.remove(corpus_path)
        os.remove(parsed_path)
        deleted_files.append(doc_data["filename"])

    # Remove folder entry from folders.json
    folders_data["folders"] = [
        e for e in folders_data["folders"] if e["folder_name"] != folder_name
    ]
    with open(folders_path, "w", encoding="utf-8") as f:
        json.dump(folders_data, f, indent=2)

    _update_inventory(proj_dir)
    from services.version_control import commit_project
    commit_project(proj_dir, f"Folder deleted: {folder_name} ({len(deleted_files)} documents)")

    return jsonify({"status": "deleted", "deleted_count": len(deleted_files)})


@documents_bp.route("/<project_id>/<int:doc_index>", methods=["DELETE"])
def delete_document(project_id, doc_index):
    parsed_path = os.path.join(PROJECTS_DIR, project_id, "parsed", f"doc_{doc_index:03d}.json")
    if not os.path.exists(parsed_path):
        return jsonify({"error": "Document not found"}), 404

    with open(parsed_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    corpus_path = os.path.join(PROJECTS_DIR, project_id, "corpus", data["filename"])

    if os.path.exists(corpus_path):
        os.remove(corpus_path)
    os.remove(parsed_path)

    _update_inventory(os.path.join(PROJECTS_DIR, project_id))
    from services.version_control import commit_project
    commit_project(os.path.join(PROJECTS_DIR, project_id), f"Document deleted: {data['filename']}")

    return jsonify({"status": "deleted"})


@documents_bp.route("/<project_id>/unit/<unit_id>", methods=["GET"])
def get_unit(project_id, unit_id):
    """Return a single unit's data by unit_id for preview popups."""
    # Parse unit_id: format is {project_short}-{doc_index}-{unit_index}
    parts = unit_id.split("-")
    if len(parts) < 3:
        return jsonify({"error": "Invalid unit_id format"}), 400

    try:
        doc_index = int(parts[1])
    except ValueError:
        return jsonify({"error": "Invalid doc_index in unit_id"}), 400

    parsed_path = os.path.join(PROJECTS_DIR, project_id, "parsed", f"doc_{doc_index:03d}.json")
    if not os.path.exists(parsed_path):
        return jsonify({"error": "Document not found"}), 404

    with open(parsed_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    units_list = data.get("units", [])
    for unit in units_list:
        if unit["unit_id"] == unit_id:
            row_data = unit.get("row_data")
            parent_unit_id = unit.get("parent_unit_id")
            if row_data is None and parent_unit_id:
                parent = next((u for u in units_list if u["unit_id"] == parent_unit_id), None)
                if parent:
                    row_data = parent.get("row_data")
            return jsonify({
                "unit_id": unit["unit_id"],
                "text": unit.get("text", ""),
                "unit_type": unit.get("unit_type"),
                "context_before": unit.get("context_before", ""),
                "context_after": unit.get("context_after", ""),
                "row_data": row_data,
                "column_name": unit.get("column_name"),
                "parent_unit_id": parent_unit_id,
                "doc_index": data["doc_index"],
                "unit_index": unit.get("unit_index"),
                "filename": data["filename"],
            })

    return jsonify({"error": "Unit not found"}), 404


@documents_bp.route("/<project_id>/<int:doc_index>/reparse-column", methods=["POST"])
def reparse_column_route(project_id, doc_index):
    """Split one column's cells into sentence-level sub-units, persisted additively."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    column_name = body.get("column_name")
    method = body.get("method", "sentence")
    delimiters = body.get("delimiters")
    if delimiters is None and body.get("delimiter"):
        delimiters = [body["delimiter"]]  # back-compat: legacy single-delimiter callers
    if not column_name:
        return jsonify({"error": "column_name is required"}), 400

    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project_short = json.load(f)["id"][:4]

    from services.unit_manager import reparse_column
    try:
        stats = reparse_column(proj_dir, project_short, doc_index, column_name, method, delimiters)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    _update_inventory(proj_dir)
    return jsonify({"status": "ok", "doc_index": doc_index, **stats})


@documents_bp.route("/<project_id>/ensure-column-reparsed", methods=["POST"])
def ensure_column_reparsed_route(project_id):
    """Proactively persist a column reparse for whatever doc(s) a block's source
    scope resolves to, idempotently — used so configuring sentence-level
    splitting on a block's settings panel is immediately reflected in the
    Document Viewer, without waiting for an analysis/alignment run to trigger it.
    """
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    column_name = body.get("column_name")
    method = body.get("method", "sentence")
    delimiters = body.get("delimiters")
    if not column_name:
        return jsonify({"error": "column_name is required"}), 400

    with open(os.path.join(proj_dir, "project.json"), "r", encoding="utf-8") as f:
        project_short = json.load(f)["id"][:4]

    from services.llm_utils import resolve_doc_indices
    from services.unit_manager import ensure_column_reparsed
    doc_indices = resolve_doc_indices(proj_dir, body)

    try:
        result = ensure_column_reparsed(proj_dir, project_short, doc_indices, column_name, method, delimiters)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if result["reparsed_doc_indices"]:
        _update_inventory(proj_dir)
    return jsonify({"status": "ok", **result})


@documents_bp.route("/<project_id>/<int:doc_index>/reparse-column", methods=["DELETE"])
def reset_column_route(project_id, doc_index):
    """Revert a column back to whole-cell by removing its sentence sub-units."""
    proj_dir = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(proj_dir):
        return jsonify({"error": "Project not found"}), 404

    body = request.get_json(silent=True) or {}
    column_name = body.get("column_name")
    if not column_name:
        return jsonify({"error": "column_name is required"}), 400

    from services.unit_manager import reset_column_granularity
    try:
        stats = reset_column_granularity(proj_dir, doc_index, column_name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    _update_inventory(proj_dir)
    return jsonify({"status": "reset", "doc_index": doc_index, **stats})


def _next_doc_index(proj_dir):
    parsed_dir = os.path.join(proj_dir, "parsed")
    if not os.path.exists(parsed_dir):
        return 0
    existing = [f for f in os.listdir(parsed_dir) if f.endswith(".json")]
    if not existing:
        return 0
    indices = []
    for f in existing:
        try:
            indices.append(int(f.replace("doc_", "").replace(".json", "")))
        except ValueError:
            pass
    return max(indices) + 1 if indices else 0


def _update_folders(proj_dir, folder_name, doc_index):
    folders_path = os.path.join(proj_dir, "folders.json")
    if os.path.exists(folders_path):
        with open(folders_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {"folders": []}

    folders = data["folders"]
    for entry in folders:
        if entry["folder_name"] == folder_name:
            if doc_index not in entry["doc_indices"]:
                entry["doc_indices"].append(doc_index)
            break
    else:
        folders.append({"folder_name": folder_name, "doc_indices": [doc_index]})

    with open(folders_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _update_inventory(proj_dir):
    parsed_dir = os.path.join(proj_dir, "parsed")
    inventory = []
    total_units = 0

    # Read project_short for the unit-ID prefix column
    project_short = ""
    project_path = os.path.join(proj_dir, "project.json")
    if os.path.exists(project_path):
        with open(project_path, "r", encoding="utf-8") as f:
            project_short = json.load(f).get("id", "")[:4]

    if os.path.exists(parsed_dir):
        for fname in sorted(os.listdir(parsed_dir)):
            if fname.endswith(".json"):
                with open(os.path.join(parsed_dir, fname), "r", encoding="utf-8") as f:
                    data = json.load(f)
                    count = len(data.get("units", []))
                    total_units += count
                    doc_index = data["doc_index"]
                    inventory.append({
                        "filename": data["filename"],
                        "doc_index": doc_index,
                        # unit_id_prefix is the stable doc prefix embedded in every unit ID
                        # e.g. "a3f2-001" — join analysis CSVs on this or on doc_index
                        "unit_id_prefix": f"{project_short}-{doc_index:03d}" if project_short else f"{doc_index:03d}",
                        "unit_count": count,
                        "unit_type": data.get("unit_type", "sentence"),
                        "folder_name": data.get("folder_name"),
                    })

    # JSON inventory
    with open(os.path.join(proj_dir, "inventory.json"), "w", encoding="utf-8") as f:
        json.dump({"documents": inventory, "total_units": total_units}, f, indent=2)

    # Markdown inventory — show doc_index and unit_id_prefix so users can join across analysis blocks
    lines = [
        "# Corpus Inventory\n",
        f"**Total units:** {total_units}\n",
        "| doc_index | unit_id_prefix | filename | units | unit_type |",
        "|-----------|---------------|----------|-------|-----------|",
    ]
    for doc in inventory:
        lines.append(
            f"| {doc['doc_index']:03d} | `{doc['unit_id_prefix']}` "
            f"| {doc['filename']} | {doc['unit_count']} | {doc['unit_type']} |"
        )
    with open(os.path.join(proj_dir, "inventory.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
