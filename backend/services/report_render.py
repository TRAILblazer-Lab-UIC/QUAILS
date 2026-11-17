"""Render QUAILS reports (authored as Markdown) to .md, .txt or .docx.

Supports the Markdown subset the report builders emit: #-#### headings,
paragraphs, - / 1. lists (one nesting level via two-space indent), pipe tables,
```fenced``` blocks, > notes, **bold**, _italic_ and `code`.
"""

import io
import re

INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|(?<![\w])_[^_]+_(?![\w]))")


def to_txt(md):
    out = []
    for line in md.splitlines():
        if line.startswith("```"):
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            title = m.group(2).strip()
            out.append("")
            out.append(title.upper() if len(m.group(1)) <= 2 else title)
            out.append(("=" if len(m.group(1)) == 1 else "-") * min(len(title), 80))
            continue
        if re.match(r"^\|?\s*-{3,}", line.replace(":", "")):
            continue
        line = line.replace("**", "").replace("`", "")
        line = re.sub(r"(?<![\w])_([^_]+)_(?![\w])", r"\1", line)
        if line.startswith("|"):
            line = "  ".join(c.strip() for c in line.strip().strip("|").split("|"))
        out.append(line)
    return "\n".join(out).strip() + "\n"


def _add_runs(paragraph, text):
    for part in INLINE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("`") and part.endswith("`"):
            r = paragraph.add_run(part[1:-1])
            r.font.name = "Courier New"
        elif part.startswith("_") and part.endswith("_") and len(part) > 2:
            paragraph.add_run(part[1:-1]).italic = True
        else:
            paragraph.add_run(part)


def to_docx(md, title=None):
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10.5)
    if title:
        doc.core_properties.title = title

    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            buf = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            p = doc.add_paragraph()
            r = p.add_run("\n".join(buf))
            r.font.name = "Courier New"
            r.font.size = Pt(9)
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            doc.add_heading(m.group(2).strip(), level=min(len(m.group(1)) - (0 if len(m.group(1)) == 1 else 0), 4))
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
                    rows.append(cells)
                i += 1
            if rows:
                ncols = max(len(r) for r in rows)
                table = doc.add_table(rows=len(rows), cols=ncols)
                table.style = "Table Grid"
                for ri, row in enumerate(rows):
                    for ci in range(ncols):
                        cell = table.cell(ri, ci)
                        cell.text = ""
                        _add_runs(cell.paragraphs[0], row[ci] if ci < len(row) else "")
                        for run in cell.paragraphs[0].runs:
                            run.font.size = Pt(9)
                            if ri == 0:
                                run.bold = True
                doc.add_paragraph()
            continue
        bm = re.match(r"^(\s*)[-*]\s+(.*)$", line)
        nm = re.match(r"^(\s*)\d+\.\s+(.*)$", line)
        if bm or nm:
            mm = bm or nm
            nested = len(mm.group(1)) >= 2
            style_name = ("List Bullet" if bm else "List Number") + (" 2" if nested else "")
            try:
                p = doc.add_paragraph(style=style_name)
            except KeyError:
                p = doc.add_paragraph(style="List Bullet" if bm else "List Number")
            _add_runs(p, mm.group(2))
            i += 1
            continue
        if line.startswith(">"):
            p = doc.add_paragraph()
            _add_runs(p, line.lstrip("> ").strip())
            for r in p.runs:
                r.italic = True
            i += 1
            continue
        if line.strip():
            p = doc.add_paragraph()
            _add_runs(p, line)
        i += 1

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def render(md, fmt, title=None):
    """Returns (bytes, mimetype, extension)."""
    fmt = (fmt or "md").lower()
    if fmt == "docx":
        return (to_docx(md, title),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx")
    if fmt == "txt":
        return to_txt(md).encode("utf-8"), "text/plain", "txt"
    return md.encode("utf-8"), "text/markdown", "md"
