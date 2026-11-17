"""Unit-of-analysis dataclass."""

from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Unit:
    """A single unit of analysis with a globally unique ID."""
    unit_id: str           # e.g., "a3f2-003-S-001-002-0007"
    text: str              # The unit text content
    unit_type: str         # S=sentence, P=paragraph, D=document, L=line, H=header, C=section, R=row-sentence
    doc_index: int         # Document index within project
    unit_index: int        # Flat sequence counter (kept for legacy compatibility)
    context_before: str = ""  # Preceding context
    context_after: str = ""   # Following context
    section_index: int = 0    # Which section (0 = before first heading)
    para_index: int = 0       # Which paragraph within the section
    sent_index: Optional[int] = None    # Which sentence within the paragraph (S-type) or cell (R-type)
    is_header: bool = False             # Whether this unit is a section header
    heading_level: Optional[int] = None # Heading level 1-6 (H-type only)
    row_data: Optional[dict] = None     # Structured row data for tabular sources
    heading_path: Optional[list] = None # Legacy: ancestor headings (Markdown)
    column_name: Optional[str] = None   # Source column for a cell sub-unit (R-type only)
    parent_unit_id: Optional[str] = None  # unit_id of the parent row (L-type), R-type only

    def to_dict(self):
        d = asdict(self)
        if d.get("row_data") is None:
            del d["row_data"]
        if d.get("heading_path") is None:
            del d["heading_path"]
        if d.get("sent_index") is None:
            del d["sent_index"]
        if d.get("heading_level") is None:
            del d["heading_level"]
        if not d.get("is_header"):
            del d["is_header"]
        if d.get("column_name") is None:
            del d["column_name"]
        if d.get("parent_unit_id") is None:
            del d["parent_unit_id"]
        return d

    @classmethod
    def from_dict(cls, d):
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
