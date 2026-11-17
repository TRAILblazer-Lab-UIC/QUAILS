"""Multi-format document ingestion (txt, csv, xlsx, xls, numbers, docx, pdf, html, md, doc)."""

import html as _html_mod
import os
import re


def _clean_text(text):
    """Normalize encoding artifacts and decode HTML entities in parsed text.

    Applied to all document formats after initial parsing to ensure clean,
    consistent text reaches the analysis pipeline.
    """
    if not text:
        return text
    # Decode HTML entities (e.g. &#039; → ', &amp; → &, &mdash; → —)
    text = _html_mod.unescape(text)
    # Strip UTF-8 BOM if present
    text = text.lstrip("\ufeff")
    # Replace Unicode replacement character with space
    text = text.replace("\ufffd", " ")
    # Normalize common mojibake sequences (UTF-8 decoded as latin-1)
    _MOJIBAKE = {
        "â\x80\x99": "\u2019",  # '
        "â\x80\x9c": "\u201c",  # "
        "â\x80\x9d": "\u201d",  # "
        "â\x80\x93": "\u2013",  # –
        "â\x80\x94": "\u2014",  # —
        "â\x80\xa6": "\u2026",  # …
        "Ã©": "é",
        "Ã¨": "è",
        "Ã±": "ñ",
        "Ã¼": "ü",
        "Ã¶": "ö",
        "Ã¤": "ä",
    }
    for bad, good in _MOJIBAKE.items():
        text = text.replace(bad, good)
    # Collapse multiple spaces (but not newlines)
    text = re.sub(r"[^\S\n]+", " ", text)
    return text


def _detect_encoding(filepath):
    """Detect file encoding using chardet, with UTF-8-sig BOM handling."""
    import chardet
    with open(filepath, "rb") as f:
        raw = f.read()
    # Check for UTF-8 BOM explicitly
    if raw[:3] == b"\xef\xbb\xbf":
        return raw, "utf-8-sig"
    detected = chardet.detect(raw)
    encoding = detected.get("encoding", "utf-8") or "utf-8"
    return raw, encoding


# ── Markdown helpers ─────────────────────────────────────────────────────────

_MD_INLINE_RE = [
    (re.compile(r'!\[([^\]]*)\]\([^\)]*\)'), r'\1'),   # images → alt text
    (re.compile(r'\[([^\]]*)\]\([^\)]*\)'), r'\1'),    # links → link text
    (re.compile(r'\[([^\]]*)\]\[[^\]]*\]'), r'\1'),    # reference links
    (re.compile(r'`([^`]+)`'), r'\1'),                  # inline code
    (re.compile(r'\*{3}([^*]+)\*{3}'), r'\1'),         # bold+italic
    (re.compile(r'\*{2}([^*]+)\*{2}'), r'\1'),         # bold
    (re.compile(r'\*([^*\n]+)\*'), r'\1'),              # italic
    (re.compile(r'_{2}([^_]+)_{2}'), r'\1'),           # __bold__
    (re.compile(r'_([^_\n]+)_'), r'\1'),               # _italic_
    (re.compile(r'~~([^~]+)~~'), r'\1'),               # ~~strikethrough~~
    (re.compile(r'<[^>]+>'), ''),                       # HTML tags
]


def _strip_md_inline(text):
    """Strip inline Markdown formatting, returning plain text."""
    for pattern, repl in _MD_INLINE_RE:
        text = pattern.sub(repl, text)
    return text.strip()


def _parse_md_table(table_lines, blocks):
    """Parse GFM-style table lines and append table_row block dicts."""
    rows = []
    for line in table_lines:
        stripped = line.strip()
        if re.match(r'^\|[\s\-:|]+\|[\s\-:|]*$', stripped):
            continue  # separator row
        cells = [c.strip() for c in stripped.strip('|').split('|')]
        if any(c for c in cells):
            rows.append(cells)

    if len(rows) < 2:
        return

    columns = [_clean_text(_strip_md_inline(c)) for c in rows[0]]
    columns = [c if c else f"Column {j + 1}" for j, c in enumerate(columns)]

    for row in rows[1:]:
        rd = {}
        parts = []
        for j, cell in enumerate(row):
            col = columns[j] if j < len(columns) else f"Column {j + 1}"
            val = _clean_text(_strip_md_inline(cell))
            if val:
                rd[col] = val
                parts.append(f"{col}: {val}")
        if parts:
            blocks.append({
                "type": "table_row",
                "text": " | ".join(parts),
                "columns": columns,
                "row_data": rd,
            })


def _build_md_sections(blocks):
    """Map each heading to the list of content blocks that follow it."""
    sections = {}
    current_heading = None
    current_blocks = []

    for block in blocks:
        if block["type"] == "heading":
            if current_heading is not None:
                sections[current_heading] = current_blocks
            current_heading = block["text"]
            current_blocks = []
        else:
            if current_heading is not None:
                current_blocks.append(block)

    if current_heading is not None:
        sections[current_heading] = current_blocks

    return sections


def _parse_markdown(filepath):
    """Parse Markdown with full structural awareness: headings, sections, code blocks, tables."""
    raw, encoding = _detect_encoding(filepath)
    body = raw.decode(encoding, errors="replace")

    # Extract YAML frontmatter (--- ... ---)
    frontmatter = {}
    fm_match = re.match(r'\A---[ \t]*\r?\n(.*?\r?\n)---[ \t]*\r?\n', body, re.DOTALL)
    if fm_match:
        fm_raw = fm_match.group(1)
        try:
            import yaml
            frontmatter = yaml.safe_load(fm_raw) or {}
        except Exception:
            frontmatter = {"_raw": fm_raw.strip()}
        body = body[fm_match.end():]

    # Normalise line endings but do NOT collapse whitespace here — code blocks
    # need their indentation. _clean_text() is applied per-block below.
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    body = body.lstrip("﻿")  # strip BOM
    lines = body.splitlines()
    blocks = []
    headings = []
    i = 0

    while i < len(lines):
        line = lines[i]

        # ATX heading: # through ######
        atx = re.match(r'^(#{1,6})[ \t]+(.*)', line)
        if atx:
            level = len(atx.group(1))
            text = _clean_text(_strip_md_inline(atx.group(2).rstrip('#').strip()))
            if text:
                blocks.append({"type": "heading", "level": level, "text": text})
                headings.append({"level": level, "text": text, "block_index": len(blocks) - 1})
            i += 1
            continue

        # Setext heading: underline with === or ---
        if i + 1 < len(lines):
            under = lines[i + 1]
            if line.strip() and re.match(r'^=+[ \t]*$', under):
                text = _clean_text(_strip_md_inline(line.strip()))
                if text:
                    blocks.append({"type": "heading", "level": 1, "text": text})
                    headings.append({"level": 1, "text": text, "block_index": len(blocks) - 1})
                i += 2
                continue
            if (line.strip() and re.match(r'^-+[ \t]*$', under)
                    and not re.match(r'^[-*_][ \t]*[-*_]', line)):
                text = _clean_text(_strip_md_inline(line.strip()))
                if text:
                    blocks.append({"type": "heading", "level": 2, "text": text})
                    headings.append({"level": 2, "text": text, "block_index": len(blocks) - 1})
                i += 2
                continue

        # Fenced code block: ``` or ~~~
        fence = re.match(r'^(`{3,}|~{3,})(.*)', line)
        if fence:
            delim = fence.group(1)[0]
            min_len = len(fence.group(1))
            lang_str = fence.group(2).strip()
            lang = lang_str.split()[0] if lang_str else ""
            code_lines = []
            i += 1
            while i < len(lines):
                cl = lines[i]
                if re.match(rf'^{re.escape(delim)}{{{min_len},}}[ \t]*$', cl):
                    i += 1
                    break
                code_lines.append(cl)
                i += 1
            code_text = "\n".join(code_lines)
            if code_text.strip():
                blocks.append({"type": "code", "language": lang, "text": code_text})
            continue

        # Blockquote: > ...
        if re.match(r'^>[ \t]?', line):
            bq_lines = []
            while i < len(lines) and (re.match(r'^>', lines[i]) or (bq_lines and lines[i].strip())):
                bq_lines.append(re.sub(r'^>[ \t]?', '', lines[i]))
                i += 1
            text = _clean_text(_strip_md_inline(" ".join(bq_lines).strip()))
            if text:
                blocks.append({"type": "blockquote", "text": text})
            continue

        # GFM table: line starts with |
        if re.match(r'^\|', line.strip()):
            tbl_lines = []
            while i < len(lines) and '|' in lines[i]:
                tbl_lines.append(lines[i])
                i += 1
            _parse_md_table(tbl_lines, blocks)
            continue

        # Thematic break: --- *** ___ (3+ repeating chars)
        if re.match(r'^[ \t]{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$', line):
            i += 1
            continue

        # List item: - * + or 1. 1)  (one or more spaces/tabs after marker)
        li = re.match(r'^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)', line)
        if li:
            ordered = bool(re.match(r'\d', li.group(2)))
            indent = len(li.group(1)) + 2
            item_lines = [li.group(3)]
            i += 1
            while i < len(lines):
                nl = lines[i]
                if not nl.strip():
                    break
                if re.match(r'^[ \t]*([-*+]|\d+[.)])[ \t]+', nl):
                    break
                nl_indent = len(nl) - len(nl.lstrip())
                if nl_indent >= indent or nl.startswith('\t'):
                    item_lines.append(nl.strip())
                    i += 1
                else:
                    break
            text = _clean_text(_strip_md_inline(" ".join(item_lines)))
            if text:
                blocks.append({"type": "list_item", "ordered": ordered, "text": text})
            continue

        # Blank line
        if not line.strip():
            i += 1
            continue

        # Paragraph: accumulate until blank line or block-level element
        para_lines = [line]
        i += 1
        while i < len(lines):
            nl = lines[i]
            if not nl.strip():
                break
            if (re.match(r'^#{1,6}[ \t]', nl)
                    or re.match(r'^(`{3,}|~{3,})', nl)
                    or re.match(r'^>[ \t]?', nl)
                    or re.match(r'^\|', nl.strip())
                    or re.match(r'^[ \t]{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$', nl)
                    or re.match(r'^[ \t]*([-*+]|\d+[.)])[ \t]+', nl)):
                break
            para_lines.append(nl)
            i += 1
        text = _clean_text(_strip_md_inline(" ".join(para_lines)))
        if text:
            blocks.append({"type": "paragraph", "text": text})

    # Assemble sections map and flat text
    sections = _build_md_sections(blocks)

    text_parts = []
    for b in blocks:
        if b["type"] == "heading":
            text_parts.append("#" * b["level"] + " " + b["text"])
        else:
            text_parts.append(b["text"])
    full_text = "\n\n".join(p for p in text_parts if p)

    table_blocks = [b for b in blocks if b["type"] == "table_row"]
    has_tables = bool(table_blocks)
    columns = table_blocks[0].get("columns", []) if table_blocks else []
    row_data = [b["row_data"] for b in table_blocks if b.get("row_data")]

    return {
        "text": full_text,
        "paragraphs": [b["text"] for b in blocks if b["type"] == "paragraph"],
        "format": "markdown",
        "lines": full_text.splitlines(),
        "blocks": blocks,
        "headings": headings,
        "sections": sections,
        "frontmatter": frontmatter,
        "has_tables": has_tables,
        "columns": columns,
        "row_data": row_data,
    }


# ── End Markdown helpers ──────────────────────────────────────────────────────


def parse_document(filepath):
    """Parse a document file and return its text content.

    Returns a dict with:
        - text: full text content
        - paragraphs: list of paragraph strings
        - format: detected format
    Or None if parsing fails.
    """
    ext = os.path.splitext(filepath)[1].lower()
    parsers = {
        ".txt": _parse_text,
        ".md": _parse_markdown,
        ".csv": _parse_csv,
        ".xlsx": _parse_xlsx,
        ".xls": _parse_xls,
        ".numbers": _parse_numbers,
        ".docx": _parse_docx,
        ".pdf": _parse_pdf,
        ".html": _parse_html,
        ".htm": _parse_html,
        ".doc": _parse_doc,
    }

    parser = parsers.get(ext)
    if not parser:
        print(f"[document_parser] Unsupported format: {ext}")
        return None

    try:
        return parser(filepath)
    except Exception as e:
        print(f"[document_parser] Error parsing {filepath}: {e}")
        return None


def _parse_text(filepath):
    raw, encoding = _detect_encoding(filepath)
    text = raw.decode(encoding, errors="replace")
    text = _clean_text(text)
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    return {"text": text, "paragraphs": paragraphs, "format": "text", "lines": text.splitlines()}


def _parse_tabular(df, format_name):
    """Shared parser for CSV/XLSX/XLS DataFrames.

    Returns dict with columns, row_data (list of dicts), labeled text lines.
    Skips NaN/None cells and entirely empty rows.
    """
    import pandas as pd
    columns = [_clean_text(str(c)) for c in df.columns]
    lines = []
    row_data = []
    for _, row in df.iterrows():
        rd = {}
        parts = []
        for col_raw, col_clean in zip(df.columns, columns):
            val = row[col_raw]
            if pd.isna(val):
                continue
            val_str = _clean_text(str(val).strip())
            if not val_str:
                continue
            rd[col_clean] = val_str
            parts.append(f"{col_clean}: {val_str}")
        if not parts:
            continue
        lines.append(" | ".join(parts))
        row_data.append(rd)
    text = "\n".join(lines)
    return {
        "text": text,
        "paragraphs": lines,
        "format": format_name,
        "lines": lines,
        "columns": columns,
        "row_data": row_data,
    }


def _parse_csv(filepath):
    import pandas as pd
    _raw, encoding = _detect_encoding(filepath)
    df = pd.read_csv(filepath, encoding=encoding, encoding_errors="replace")
    return _parse_tabular(df, "csv")


def _parse_xlsx(filepath):
    import pandas as pd
    df = pd.read_excel(filepath, engine="openpyxl")
    return _parse_tabular(df, "xlsx")


def _parse_xls(filepath):
    import pandas as pd
    df = pd.read_excel(filepath, engine="xlrd")
    return _parse_tabular(df, "xls")


def _parse_numbers(filepath):
    """Parse an Apple Numbers document (first table of the first sheet).

    Numbers files can contain multiple sheets and multiple tables per sheet;
    like the Excel parsers, only the first table is read (the frontend warns
    the user about this limitation on upload, same as multi-sheet xlsx/xls).
    """
    import pandas as pd
    from numbers_parser import Document

    doc = Document(filepath)
    table = doc.sheets[0].tables[0]
    rows = table.rows(values_only=True)
    if not rows:
        return _parse_tabular(pd.DataFrame(), "numbers")

    header, *data_rows = rows
    df = pd.DataFrame(data_rows, columns=header)
    # Numbers pads its grid with empty trailing rows/columns — drop them.
    df = df.dropna(axis=1, how="all").dropna(axis=0, how="all")
    return _parse_tabular(df, "numbers")


def _detect_docx_header(all_rows):
    """Detect whether the first row of a table is a header.

    Returns (columns, data_rows).
    """
    if not all_rows:
        return [], []

    num_cols = len(all_rows[0])

    if len(all_rows) > 1 and all(cell.strip() for cell in all_rows[0]):
        # First row has all non-empty cells and there are data rows — treat as header
        columns = [cell.strip() for cell in all_rows[0]]
        data_rows = all_rows[1:]
    else:
        columns = [f"Column {i+1}" for i in range(num_cols)]
        data_rows = all_rows

    # Ensure no empty column names
    columns = [c if c else f"Column {i+1}" for i, c in enumerate(columns)]
    return columns, data_rows


def _docx_table_to_blocks(table):
    """Convert a python-docx Table to (columns, list_of_table_row_blocks)."""
    all_rows = [[_clean_text(cell.text.strip()) for cell in row.cells] for row in table.rows]
    if not all_rows:
        return [], []

    columns, data_rows = _detect_docx_header(all_rows)

    blocks = []
    for row in data_rows:
        row_data = {}
        parts = []
        all_empty = True
        for i, col in enumerate(columns):
            val = row[i] if i < len(row) else ""
            val_str = val.strip() if val else ""
            if not val_str:
                continue
            all_empty = False
            row_data[col] = val_str
            parts.append(f"{col}: {val_str}")
        if all_empty:
            continue
        blocks.append({
            "type": "table_row",
            "text": " | ".join(parts),
            "row_data": row_data,
            "columns": columns,
        })

    return columns, blocks


def _all_runs_bold(para, text):
    """Return True if the paragraph is short and every text-bearing run is explicitly bold.

    Catches 'fake headings' created by selecting text and pressing Ctrl+B in Word
    without applying a Heading paragraph style.
    """
    if len(text) > 120:
        return False
    runs = [r for r in para.runs if r.text.strip()]
    return bool(runs) and all(r.bold is True for r in runs)


def _parse_docx(filepath):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    doc = Document(filepath)
    body = doc.element.body

    blocks = []
    has_tables = False
    first_columns = None

    for child in body:
        tag = child.tag
        if tag == qn("w:p"):
            para = Paragraph(child, body)
            text = _clean_text(para.text.strip())
            if text:
                style_name = para.style.name if para.style else ""
                if style_name.startswith("Heading"):
                    parts = style_name.split()
                    level = int(parts[-1]) if len(parts) >= 2 and parts[-1].isdigit() else 1
                    blocks.append({"type": "heading", "level": level, "text": text})
                elif style_name in ("Title", "Subtitle"):
                    blocks.append({"type": "heading", "level": 1, "text": text})
                elif _all_runs_bold(para, text):
                    # Fallback: short paragraph where every run is explicitly bold
                    # catches "fake headings" styled with Ctrl+B instead of Heading styles
                    blocks.append({"type": "heading", "level": 1, "text": text})
                else:
                    blocks.append({"type": "text", "text": text})
        elif tag == qn("w:tbl"):
            table = Table(child, body)
            col_names, table_blocks = _docx_table_to_blocks(table)
            if table_blocks:
                has_tables = True
                if first_columns is None:
                    first_columns = col_names
                blocks.extend(table_blocks)
        # Skip other elements (section breaks, etc.)

    lines = [block["text"] for block in blocks]
    text = "\n\n".join(lines)
    paragraphs = [line for line in lines if line.strip()]
    row_data_list = [
        block.get("row_data") if block["type"] == "table_row" else None
        for block in blocks
    ]

    result = {
        "text": text,
        "paragraphs": paragraphs,
        "format": "docx",
        "lines": lines,
        "blocks": blocks,
        "has_tables": has_tables,
    }
    if first_columns is not None:
        result["columns"] = first_columns
    if has_tables:
        result["row_data"] = row_data_list
    return result


def _parse_pdf(filepath):
    import fitz  # PyMuPDF
    doc = fitz.open(filepath)
    all_blocks = []
    has_tables = False
    first_columns = None
    prev_columns = None

    for page in doc:
        page_blocks, page_has_tables, page_cols = _pdf_blocks_from_page(page, prev_columns)
        all_blocks.extend(page_blocks)
        if page_has_tables:
            has_tables = True
        if first_columns is None and page_cols:
            first_columns = page_cols
        if page_cols:
            prev_columns = page_cols

    doc.close()

    if not all_blocks:
        print(f"[document_parser] WARNING: PDF '{filepath}' contains no extractable text. OCR not supported.")
        return {"text": "", "paragraphs": [], "format": "pdf", "warning": "no_text"}

    lines = []
    row_data_list = []
    for block in all_blocks:
        lines.append(block["text"])
        row_data_list.append(block.get("row_data") if block["type"] == "table_row" else None)

    text = "\n\n".join(lines)
    paragraphs = [l for l in lines if l.strip()]

    result = {
        "text": text,
        "paragraphs": paragraphs,
        "format": "pdf",
        "lines": lines,
        "blocks": all_blocks,
        "has_tables": has_tables,
    }
    if first_columns is not None:
        result["columns"] = first_columns
    if has_tables:
        result["row_data"] = row_data_list
    return result


def _rects_overlap(text_bbox, table_bboxes):
    """Return True if the text block's rect overlaps any table rect by >50% of text block area."""
    import fitz
    text_rect = fitz.Rect(text_bbox)
    text_area = text_rect.get_area()
    if text_area == 0:
        return False
    for table_bbox in table_bboxes:
        table_rect = fitz.Rect(table_bbox)
        intersection = text_rect & table_rect
        if intersection.get_area() > 0.5 * text_area:
            return True
    return False


def _pdf_table_to_blocks(table):
    """Convert a PyMuPDF Table to (columns, list_of_table_row_blocks)."""
    header = table.header
    col_names = list(header.names) if header.names else []
    data = table.extract()

    if not data:
        return [], []

    # Determine which rows are data rows
    if header.external:
        # Header is external (e.g. from a prior row outside the table bbox)
        data_rows = data
    else:
        # First row of extract() is the header — skip it
        data_rows = data[1:] if len(data) > 1 else []

    # Fix empty/None column names
    if not col_names:
        num_cols = len(data[0]) if data else 0
        col_names = [f"Column {i+1}" for i in range(num_cols)]
    else:
        col_names = [c if c else f"Column {i+1}" for i, c in enumerate(col_names)]

    # Clean column names
    col_names = [_clean_text(c) if c else f"Column {i+1}" for i, c in enumerate(col_names)]

    blocks = []
    for row in data_rows:
        row_data = {}
        parts = []
        all_empty = True
        for i, col in enumerate(col_names):
            val = row[i] if i < len(row) else None
            if val is None:
                continue
            val_str = _clean_text(str(val).strip())
            if not val_str:
                continue
            all_empty = False
            row_data[col] = val_str
            parts.append(f"{col}: {val_str}")
        if all_empty:
            continue
        blocks.append({
            "type": "table_row",
            "text": " | ".join(parts),
            "row_data": row_data,
            "columns": col_names,
        })

    return col_names, blocks


def _pdf_blocks_from_page(page, prev_columns=None):
    """Extract ordered content blocks from a PDF page using structured APIs.

    Returns (blocks, has_tables, columns).
    """
    import fitz

    # Get tables and their bounding boxes
    table_finder = page.find_tables()
    tables = table_finder.tables if table_finder else []
    table_bboxes = [t.bbox for t in tables]

    # Get positioned text blocks via dict mode
    text_dict = page.get_text("dict")
    dict_blocks = text_dict.get("blocks", [])

    # Build unified event list sorted by vertical position
    # Each text event: ("text", y, text_str, avg_font_size)
    events = []
    font_size_by_y = {}

    for block in dict_blocks:
        if block.get("type") != 0:  # type 0 = text, type 1 = image
            continue
        bbox = block.get("bbox")
        if not bbox:
            continue
        # Skip text blocks that overlap with table regions
        if table_bboxes and _rects_overlap(bbox, table_bboxes):
            continue
        # Extract paragraph text, font sizes, and bold flags from lines/spans
        line_texts = []
        font_sizes = []
        span_count = 0
        bold_count = 0
        for line in block.get("lines", []):
            span_texts = []
            for span in line.get("spans", []):
                t = span.get("text", "")
                if t.strip():
                    span_texts.append(t)
                    fs = span.get("size", 0)
                    if fs:
                        font_sizes.append(fs)
                    span_count += 1
                    if span.get("flags", 0) & 16:  # bit 4 = bold in PyMuPDF
                        bold_count += 1
            if span_texts:
                line_texts.append(" ".join(span_texts))
        paragraph = _clean_text(" ".join(line_texts).strip())
        if paragraph:
            avg_size = sum(font_sizes) / len(font_sizes) if font_sizes else 0
            all_bold = span_count > 0 and bold_count == span_count
            events.append(("text", bbox[1], paragraph, avg_size, all_bold))

    for table in tables:
        events.append(("table", table.bbox[1], table, 0, False))

    # Sort by vertical position (y-top)
    events.sort(key=lambda e: e[1])

    # Compute median body text font size for heading detection
    text_sizes = sorted([e[3] for e in events if e[0] == "text" and e[3] > 0])
    median_font = text_sizes[len(text_sizes) // 2] if text_sizes else 0

    # Process events in reading order
    blocks = []
    has_tables = False
    columns = None

    for kind, _, payload, font_size, is_all_bold in events:
        if kind == "text":
            # Heading if: noticeably larger font OR (short + all-bold at body size)
            is_large = median_font > 0 and font_size > median_font * 1.2
            is_bold_heading = (
                is_all_bold
                and len(payload) < 120
                and (median_font == 0 or font_size >= median_font * 0.85)
            )
            if is_large or is_bold_heading:
                blocks.append({"type": "heading", "level": 1, "text": payload})
            else:
                blocks.append({"type": "text", "text": payload})
        elif kind == "table":
            col_names, table_blocks = _pdf_table_to_blocks(payload)
            if table_blocks:
                has_tables = True
                # If no header detected and prev_columns matches col count, reuse
                if not any(col_names) and prev_columns and len(prev_columns) == len(col_names):
                    col_names = prev_columns
                    for tb in table_blocks:
                        tb["columns"] = col_names
                if columns is None:
                    columns = col_names
                blocks.extend(table_blocks)

    return blocks, has_tables, columns


def _parse_html(filepath):
    from bs4 import BeautifulSoup
    raw, encoding = _detect_encoding(filepath)
    html = raw.decode(encoding, errors="replace")
    soup = BeautifulSoup(html, "lxml")

    blocks = _walk_html_dom(soup)

    # Extract text lines, row_data list (positionally aligned), and columns
    lines = []
    row_data_list = []
    all_columns = None
    has_tables = False
    for block in blocks:
        lines.append(block["text"])
        if block["type"] == "table_row":
            has_tables = True
            row_data_list.append(block.get("row_data"))
            if all_columns is None and "columns" in block:
                all_columns = block["columns"]
        else:
            row_data_list.append(None)

    text = "\n\n".join(lines)
    paragraphs = [line for line in lines if line.strip()]

    result = {
        "text": text,
        "paragraphs": paragraphs,
        "format": "html",
        "lines": lines,
        "blocks": blocks,
        "has_tables": has_tables,
    }
    if all_columns is not None:
        result["columns"] = all_columns
    if has_tables:
        result["row_data"] = row_data_list
    return result


# Tags that represent block-level elements (flush text buffer on encounter)
_BLOCK_TAGS = frozenset([
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "div", "blockquote", "pre", "li", "dt", "dd",
    "section", "article", "header", "footer", "main", "aside",
    "details", "summary", "ol", "ul", "dl", "figure", "figcaption",
    "hr", "nav", "address",
])

# Tags to skip entirely
_SKIP_TAGS = frozenset(["script", "style", "head"])


def _walk_html_dom(soup):
    """Walk the DOM tree and produce an ordered list of content blocks."""
    from bs4 import NavigableString, Tag

    root = soup.body if soup.body else soup
    blocks = []
    buffer = []

    def flush():
        """Flush accumulated text buffer as a text block."""
        text = " ".join(buffer).strip()
        text = _clean_text(" ".join(text.split()))  # collapse whitespace + clean
        if text:
            blocks.append({"type": "text", "text": text})
        buffer.clear()

    def walk(element):
        for child in element.children:
            if isinstance(child, NavigableString):
                stripped = child.strip()
                if stripped:
                    buffer.append(stripped)
            elif isinstance(child, Tag):
                tag_name = child.name.lower() if child.name else ""

                if tag_name in _SKIP_TAGS:
                    continue
                elif tag_name == "table":
                    flush()
                    columns, table_blocks = _parse_html_table(child)
                    blocks.extend(table_blocks)
                elif tag_name == "br":
                    buffer.append(" ")
                elif tag_name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                    flush()
                    heading_text = _clean_text(child.get_text(separator=" ", strip=True))
                    if heading_text:
                        blocks.append({"type": "heading", "level": int(tag_name[1]), "text": heading_text})
                elif tag_name in _BLOCK_TAGS:
                    flush()
                    walk(child)
                    flush()
                else:
                    # Inline tag — extract text into buffer
                    inline_text = child.get_text()
                    if inline_text and inline_text.strip():
                        buffer.append(inline_text.strip())

    walk(root)
    flush()
    return blocks


def _parse_html_table(table_tag):
    """Parse an HTML table into column names and a list of table_row blocks."""
    from bs4 import Tag

    columns = []
    rows = table_tag.find_all("tr")
    if not rows:
        return [], []

    # Determine header row
    thead = table_tag.find("thead")
    if thead:
        header_rows = thead.find_all("tr")
        if header_rows:
            header_cells = header_rows[0].find_all(["th", "td"])
            columns = [cell.get_text(strip=True) for cell in header_cells]
        data_rows = []
        tbody = table_tag.find("tbody")
        if tbody:
            data_rows = tbody.find_all("tr")
        else:
            # Rows outside thead
            data_rows = [r for r in rows if r.parent != thead]
    else:
        # No thead — check if first row has <th> cells
        first_row_cells = rows[0].find_all(["th", "td"])
        has_th = any(
            isinstance(cell, Tag) and cell.name == "th"
            for cell in rows[0].find_all(["th", "td"])
        )
        if has_th:
            columns = [cell.get_text(strip=True) for cell in first_row_cells]
            data_rows = rows[1:]
        else:
            # No headers at all — generate synthetic column names
            num_cols = len(first_row_cells)
            columns = [f"Column {i+1}" for i in range(num_cols)]
            data_rows = rows

    # Ensure non-empty column names
    columns = [c if c else f"Column {i+1}" for i, c in enumerate(columns)]

    table_blocks = []
    for tr in data_rows:
        cells = tr.find_all(["td", "th"])
        cell_texts = [_clean_text(cell.get_text(strip=True)) for cell in cells]

        # Skip entirely empty rows
        if not any(cell_texts):
            continue

        # Build row_data dict and text representation
        row_data = {}
        parts = []
        for i, col in enumerate(columns):
            val = cell_texts[i] if i < len(cell_texts) else ""
            if val:
                row_data[col] = val
                parts.append(f"{col}: {val}")

        if parts:
            table_blocks.append({
                "type": "table_row",
                "text": " | ".join(parts),
                "row_data": row_data,
                "columns": columns,
            })

    return columns, table_blocks


def _parse_doc(filepath):
    """Parse .doc files by converting to .docx via LibreOffice."""
    import subprocess
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            result = subprocess.run(
                ["soffice", "--headless", "--convert-to", "docx", "--outdir", tmpdir, filepath],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                print(f"[document_parser] LibreOffice conversion failed. Please convert .doc to .docx manually.")
                return None
            basename = os.path.splitext(os.path.basename(filepath))[0] + ".docx"
            converted = os.path.join(tmpdir, basename)
            return _parse_docx(converted)
    except FileNotFoundError:
        print("[document_parser] LibreOffice not found. Please convert .doc files to .docx manually.")
        return None
    except Exception as e:
        print(f"[document_parser] .doc conversion error: {e}")
        return None
