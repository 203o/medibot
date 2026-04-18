from __future__ import annotations

import re


SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
WHITESPACE_RE = re.compile(r"\s+")


def normalize_text(value: str) -> str:
    return WHITESPACE_RE.sub(" ", (value or "").strip())


def split_sentences(text: str) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    return [sentence.strip() for sentence in SENTENCE_SPLIT_RE.split(normalized) if len(sentence.strip()) > 35]


def score_sentence(sentence: str, keywords: list[str]) -> int:
    lower = sentence.lower()
    score = 0
    for keyword in keywords:
        if keyword and keyword.lower() in lower:
            score += 2
    if any(term in lower for term in ["trial", "study", "review", "effect", "outcome", "treatment", "hydration", "malaria"]):
        score += 1
    return score


def extract_evidence_sentences(text: str, keywords: list[str], limit: int = 3) -> list[str]:
    sentences = split_sentences(text)
    ranked = sorted(
        ((score_sentence(sentence, keywords), sentence) for sentence in sentences),
        key=lambda item: (item[0], len(item[1])),
        reverse=True,
    )
    selected: list[str] = []
    for score, sentence in ranked:
        if score <= 0 and selected:
            continue
        if sentence not in selected:
            selected.append(sentence)
        if len(selected) >= limit:
            break
    return selected
