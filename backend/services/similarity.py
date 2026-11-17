"""Semantic similarity using TF-IDF cosine similarity.

Uses nltk for tokenization + stemming and numpy for vector math.
Both are already project dependencies (nltk in requirements.txt,
numpy via pandas). No compilation required — works on Python 3.14.
"""

import re
import math

import numpy as np
from nltk.stem import PorterStemmer
from nltk.corpus import stopwords

_stemmer = None
_stopwords = None


# Used when NLTK's stopword corpus is not installed and cannot be downloaded
# (offline machines). A standard English list; similarity stays well-defined.
_FALLBACK_STOPWORDS = set("""
a about above after again against all am an and any are as at be because been before being below between both
but by can did do does doing down during each few for from further had has have having he her here hers herself
him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only
or other our ours ourselves out over own same she should so some such than that the their theirs them themselves
then there these they this those through to too under until up very was we were what when where which while who
whom why will with would you your yours yourself yourselves
""".split())


def _ensure_nltk():
    """Ensure the stemmer and stopword list are available.

    Both globals are assigned together at the end, so a failed corpus lookup can
    never leave a half-initialised state; without the NLTK corpus (and no network
    to download it) a built-in English stopword list is used instead.
    """
    global _stemmer, _stopwords
    if _stemmer is not None and _stopwords is not None:
        return
    words = None
    try:
        words = set(stopwords.words("english"))
    except LookupError:
        try:
            import nltk
            if nltk.download("stopwords", quiet=True):
                words = set(stopwords.words("english"))
        except Exception:
            words = None
    _stopwords = words or _FALLBACK_STOPWORDS
    _stemmer = PorterStemmer()


def _tokenize(text):
    """Lowercase, strip punctuation, remove stopwords, stem."""
    _ensure_nltk()
    words = re.findall(r"[a-z]+", text.lower())
    return [_stemmer.stem(w) for w in words if w not in _stopwords and len(w) > 1]


def _build_tfidf_vectors(texts):
    """Build TF-IDF vectors for a list of texts.

    Returns (matrix as list of dicts, vocabulary set).
    """
    tokenized = [_tokenize(t) for t in texts]

    # Document frequency
    df = {}
    for tokens in tokenized:
        for term in set(tokens):
            df[term] = df.get(term, 0) + 1

    n_docs = len(texts)
    vectors = []
    for tokens in tokenized:
        # Term frequency
        tf = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        # Normalize TF and apply IDF
        max_tf = max(tf.values()) if tf else 1
        vec = {}
        for term, count in tf.items():
            idf = math.log((n_docs + 1) / (df.get(term, 0) + 1)) + 1
            vec[term] = (count / max_tf) * idf
        vectors.append(vec)

    return vectors


def _cosine_sim(vec_a, vec_b):
    """Cosine similarity between two sparse vectors (dicts)."""
    if not vec_a or not vec_b:
        return 0.0
    # Shared terms
    common = set(vec_a) & set(vec_b)
    if not common:
        return 0.0
    dot = sum(vec_a[t] * vec_b[t] for t in common)
    norm_a = math.sqrt(sum(v * v for v in vec_a.values()))
    norm_b = math.sqrt(sum(v * v for v in vec_b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def text_similarity(text_a, text_b):
    """Compute similarity between two text strings.

    Combines TF-IDF cosine similarity with token overlap (Jaccard).
    Returns float 0-100 (percentage).
    """
    tokens_a = set(_tokenize(text_a))
    tokens_b = set(_tokenize(text_b))

    if not tokens_a and not tokens_b:
        return 100.0  # Both empty = identical
    if not tokens_a or not tokens_b:
        return 0.0

    # Jaccard overlap (handles short labels well)
    intersection = tokens_a & tokens_b
    union = tokens_a | tokens_b
    jaccard = len(intersection) / len(union) if union else 0.0

    # TF-IDF cosine (handles longer phrases better)
    vecs = _build_tfidf_vectors([text_a, text_b])
    cosine = _cosine_sim(vecs[0], vecs[1])

    # Weighted blend: jaccard for short labels, cosine for longer text
    avg_len = (len(tokens_a) + len(tokens_b)) / 2
    if avg_len <= 2:
        score = 0.7 * jaccard + 0.3 * cosine
    else:
        score = 0.3 * jaccard + 0.7 * cosine

    return round(max(0.0, min(1.0, score)) * 100, 1)


def find_best_pairings(human_labels, llm_labels):
    """Find best semantic matches between human and LLM label sets.

    Uses greedy matching: pick highest similarity pair, remove both, repeat.

    Returns:
        matched: list of {"human": str, "llm": str, "similarity": float}
        unmatched_human: list of str
        unmatched_llm: list of str
    """
    if not human_labels or not llm_labels:
        return [], list(human_labels or []), list(llm_labels or [])

    h_list = list(human_labels)
    l_list = list(llm_labels)

    # Compute all pairwise similarities
    pairs = []
    for h in h_list:
        for l in l_list:
            sim = text_similarity(h, l)
            pairs.append((h, l, sim))

    # Greedy matching by highest similarity
    pairs.sort(key=lambda x: x[2], reverse=True)
    matched = []
    used_h = set()
    used_l = set()

    for h, l, sim in pairs:
        if h in used_h or l in used_l:
            continue
        matched.append({"human": h, "llm": l, "similarity": sim})
        used_h.add(h)
        used_l.add(l)

    unmatched_human = [h for h in h_list if h not in used_h]
    unmatched_llm = [l for l in l_list if l not in used_l]

    return matched, unmatched_human, unmatched_llm
