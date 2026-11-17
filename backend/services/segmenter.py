"""Sentence/paragraph segmentation with NLTK Punkt and regex fallback."""

import re

_nltk_available = None


def _check_nltk():
    """Check if NLTK Punkt tokenizer is available; auto-download if needed."""
    global _nltk_available
    if _nltk_available is not None:
        return _nltk_available
    try:
        import nltk
        try:
            nltk.data.find("tokenizers/punkt_tab")
        except LookupError:
            print("[segmenter] Downloading NLTK punkt_tab tokenizer data...")
            nltk.download("punkt_tab", quiet=True)
        # Verify it works
        nltk.sent_tokenize("Test sentence.")
        _nltk_available = True
    except Exception as e:
        print(f"[segmenter] NLTK unavailable: {e}")
        _nltk_available = False
    return _nltk_available


# Improved regex sentence splitter for last-resort fallback.
# Avoids splitting after digits (decimals) and ellipsis. Abbreviations
# are NOT handled here — use NLTK for proper abbreviation support.
_SENTENCE_RE = re.compile(
    r'(?<!\d)'            # Not preceded by a digit (avoids decimals like 3.50)
    r'(?<!\.\.)'          # Not preceded by .. (avoids ellipsis)
    r'(?<=[.!?])'         # Lookbehind for sentence-ending punctuation
    r'(?:\s+)'            # Followed by whitespace
    r'(?=[A-Z"\'\(])'     # Lookahead for capital letter, quote, or paren
)


def _clean_segments(segments):
    """Post-process segments: strip, collapse internal whitespace, filter empties."""
    result = []
    for s in segments:
        s = s.strip()
        if not s:
            continue
        s = re.sub(r'\s+', ' ', s)
        result.append(s)
    return result


def _regex_segment_sentences(text):
    """Regex-based sentence segmentation (last resort)."""
    text = re.sub(r'\n+', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []
    sentences = _SENTENCE_RE.split(text)
    return _clean_segments(sentences)


def segment_sentences(text):
    """Segment text into sentences. Priority: NLTK Punkt > regex."""
    if not text or not text.strip():
        return []

    if _check_nltk():
        import nltk
        # Normalize whitespace for cleaner tokenization
        normalized = re.sub(r'\n+', ' ', text)
        normalized = re.sub(r'\s+', ' ', normalized).strip()
        sentences = nltk.sent_tokenize(normalized)
        return _clean_segments(sentences)

    return _regex_segment_sentences(text)


def segment_paragraphs(paragraphs):
    """Split text or list into paragraphs on double-newlines."""
    if isinstance(paragraphs, str):
        # Normalize line endings and split on double-newlines
        text = paragraphs.replace('\r\n', '\n')
        parts = re.split(r'\n\n+', text)
        return _clean_segments(parts)
    return _clean_segments(paragraphs)


def segment_document(text):
    """Return the entire document as a single unit."""
    cleaned = _clean_segments([text]) if text else []
    return cleaned


def segment_lines(lines):
    """Return lines as-is (for CSV data)."""
    if isinstance(lines, str):
        return _clean_segments(lines.splitlines())
    return _clean_segments(lines)


def segment_by_delimiters(text, delimiters):
    """Split a single cell's text on any of several literal user-supplied delimiter strings.

    Accepts a single delimiter string (legacy callers) or a list of delimiter
    strings — the cell is split wherever ANY of them occurs, so rows using
    different separators (e.g. some with "." and others with ";") can share
    one re-parse pass.
    """
    if not text or not delimiters:
        return []
    if isinstance(delimiters, str):
        delimiters = [delimiters]
    delims = [d for d in delimiters if d]
    if not delims:
        return []
    pattern = "|".join(re.escape(d) for d in delims)
    return _clean_segments(re.split(pattern, text))


def segment_sentences_and_delimiters(text, delimiters):
    """Split a cell using both sentence-boundary detection AND literal delimiters.

    Runs sentence segmentation first (so abbreviation-aware period handling
    still applies), then further splits each resulting sentence on any of the
    given delimiters — catching separators like ";" that sentence tokenizers
    don't treat as sentence-ending punctuation. Falls back to plain sentence
    segmentation if no delimiters are given.
    """
    if not text or not text.strip():
        return []
    sentences = segment_sentences(text)
    if not delimiters:
        return sentences
    result = []
    for sentence in sentences:
        result.extend(segment_by_delimiters(sentence, delimiters))
    return result


_TXT_HEADING_END_RE = re.compile(r'[.?!;:,]$')


def _is_txt_heading(text):
    """Heuristic: short, non-punctuated line is likely a heading.

    Strong signal: ALL CAPS (works even for single words like "INTRODUCTION").
    Moderate signal: short line (<=60 chars) with no terminal punctuation and 2+ words.
    """
    if not text or len(text) > 80:
        return False
    if _TXT_HEADING_END_RE.search(text):
        return False
    # All-caps is a strong heading signal (single or multi-word)
    if text.upper() == text and any(c.isalpha() for c in text):
        return True
    # Short multi-word line with no terminal punctuation
    words = text.split()
    return len(words) >= 2 and len(text) <= 60


def extract_structure(parsed_doc):
    """Convert parsed document into Document > Section > Paragraph > Sentence hierarchy.

    Returns:
        {"sections": [{"section_index": int, "heading": None|{"text":str,"level":int},
                       "paragraphs": [{"para_index":int,"text":str,"sentences":[str],...}]}]}
    """
    fmt = parsed_doc.get("format", "")

    # Tabular formats: no hierarchical structure
    if fmt in ("csv", "xlsx", "xls", "numbers"):
        return {"sections": []}

    sections = []
    sec_heading = None
    sec_paras = []
    para_idx = 0

    def push_section():
        nonlocal sec_heading, sec_paras, para_idx
        if sec_paras or sec_heading is not None:
            sections.append({
                "section_index": len(sections),
                "heading": sec_heading,
                "paragraphs": sec_paras,
            })
        sec_heading = None
        sec_paras = []
        para_idx = 0

    def add_para(text, sentences, row_data=None):
        nonlocal para_idx
        entry = {"para_index": para_idx, "text": text, "sentences": sentences}
        if row_data:
            entry["row_data"] = row_data
        sec_paras.append(entry)
        para_idx += 1

    blocks = parsed_doc.get("blocks")

    if blocks:
        for block in blocks:
            btype = block.get("type")
            if btype == "heading":
                push_section()
                sec_heading = {"text": block["text"], "level": block.get("level", 1)}
            elif btype in ("paragraph", "text", "list_item", "blockquote"):
                text = block.get("text", "").strip()
                if text:
                    add_para(text, segment_sentences(text))
            elif btype == "code":
                text = block.get("text", "").strip()
                if text:
                    add_para(text, [text])
            elif btype == "table_row":
                text = block.get("text", "").strip()
                if text:
                    add_para(text, [text], block.get("row_data"))
    else:
        # TXT: heuristic heading detection from paragraphs list
        for para_text in parsed_doc.get("paragraphs", []):
            para_text = para_text.strip()
            if not para_text:
                continue
            if _is_txt_heading(para_text):
                push_section()
                sec_heading = {"text": para_text, "level": 1}
            else:
                add_para(para_text, segment_sentences(para_text))

    # Flush final section
    push_section()

    if not sections:
        sections.append({"section_index": 0, "heading": None, "paragraphs": []})

    return {"sections": sections}
