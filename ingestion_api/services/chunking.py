from __future__ import annotations

from typing import Any
import re


def _normalize_text(value: str) -> str:
    return " ".join((value or "").split())


GENERIC_PATTERNS = (
    "further studies are needed",
    "more research is needed",
    "authors declare",
    "copyright",
    "trial record",
)

EVIDENCE_CUES = (
    "result", "conclusion", "found", "associated", "reduced", "improved",
    "compared", "versus", "outcome", "effective", "safety", "efficacy",
)


def _sentence_score(text: str, record: dict[str, Any], source: str) -> int:
    normalized = _normalize_text(text).lower()
    if len(normalized) < 40:
        return -1
    if any(pattern in normalized for pattern in GENERIC_PATTERNS):
        return -1

    keywords = [str(value).lower() for value in record.get("query_keywords", []) if value]
    title = str(record.get("title", "")).lower()
    score = 0

    for keyword in keywords:
        if keyword in normalized:
            score += 3 if " " in keyword else 2
        if keyword in title and keyword in normalized:
            score += 1

    if any(cue in normalized for cue in EVIDENCE_CUES):
        score += 2
    if source == "clinicaltrials" and any(word in normalized for word in ("phase", "randomized", "intervention", "primary outcome")):
        score += 2
    if source == "pubmed" and any(word in normalized for word in ("systematic review", "meta-analysis", "trial", "cohort")):
        score += 1

    if 60 <= len(normalized) <= 360:
        score += 1
    return score


def _split_long_text(text: str) -> list[str]:
    normalized = _normalize_text(text)
    if not normalized:
        return []
    parts = re.split(r"(?<=[.!?])\s+", normalized)
    return [part.strip() for part in parts if len(part.strip()) > 30]


def _record_to_chunks(record: dict[str, Any], source: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for sentence in record.get("evidence_sentences", []):
        score = _sentence_score(sentence, record, source)
        if score >= 0:
            candidates.append({
                "text": _normalize_text(sentence),
                "score": score + 2,
                "chunk_type": "evidence_sentence",
            })

    if not candidates:
        if source == "pubmed":
            for section in record.get("abstract_sections", []):
                for sentence in _split_long_text(section):
                    score = _sentence_score(sentence, record, source)
                    if score >= 0:
                        candidates.append({
                            "text": sentence,
                            "score": score,
                            "chunk_type": "abstract_section",
                        })
            if not candidates and record.get("abstract"):
                for sentence in _split_long_text(record["abstract"]):
                    score = _sentence_score(sentence, record, source)
                    if score >= 0:
                        candidates.append({
                            "text": sentence,
                            "score": score,
                            "chunk_type": "abstract_sentence",
                        })
        elif source == "clinicaltrials":
            for field in ["brief_summary", "detailed_description"]:
                for sentence in _split_long_text(record.get(field, "")):
                    score = _sentence_score(sentence, record, source)
                    if score >= 0:
                        candidates.append({
                            "text": sentence,
                            "score": score,
                            "chunk_type": field,
                        })
        else:
            for field in ["abstract", "summary"]:
                for sentence in _split_long_text(record.get(field, "")):
                    score = _sentence_score(sentence, record, source)
                    if score >= 0:
                        candidates.append({
                            "text": sentence,
                            "score": score,
                            "chunk_type": field,
                        })

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in sorted(candidates, key=lambda candidate: candidate["score"], reverse=True):
        if item["text"] in seen:
            continue
        seen.add(item["text"])
        deduped.append(item)
    return deduped[:8]


def build_chunks(
    pubmed_records: list[dict[str, Any]],
    clinical_trials_records: list[dict[str, Any]],
    openalex_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []

    for source, records in [
        ("pubmed", pubmed_records),
        ("clinicaltrials", clinical_trials_records),
        ("openalex", openalex_records),
    ]:
        for record in records:
            if source == "pubmed":
                record_id = record.get("pmid")
            elif source == "clinicaltrials":
                record_id = record.get("nct_id")
            else:
                record_id = record.get("openalex_id")
            if not record_id:
                continue

            for index, chunk in enumerate(_record_to_chunks(record, source)):
                chunks.append(
                    {
                        "id": f"{source}:{record_id}:{index}",
                        "doc_id": record_id,
                        "source": source,
                        "title": record.get("title", ""),
                        "study_type": (
                            ", ".join(record.get("publication_types", []))
                            if source == "pubmed"
                            else record.get("study_type", "Clinical trial")
                            if source == "clinicaltrials"
                            else record.get("type", "Publication")
                        ),
                        "year": record.get("year") or record.get("last_update", "")[:4],
                        "url": record.get("source_url", ""),
                        "text": chunk["text"],
                        "chunk_type": chunk["chunk_type"],
                        "chunk_score": chunk["score"],
                    }
                )

    return chunks
