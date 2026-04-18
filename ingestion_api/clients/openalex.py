from __future__ import annotations

from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json

from ingestion_api.services.evidence_extraction import extract_evidence_sentences


BASE_URL = "https://api.openalex.org/works"


def _get_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "medibot-fastapi-ingestion"})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _decode_abstract(inverted_index: dict[str, list[int]] | None) -> str:
    if not inverted_index:
        return ""

    max_position = -1
    for positions in inverted_index.values():
        if positions:
            max_position = max(max_position, max(positions))
    if max_position < 0:
        return ""

    words = [""] * (max_position + 1)
    for token, positions in inverted_index.items():
        for position in positions:
            if 0 <= position < len(words):
                words[position] = token
    return " ".join(word for word in words if word).strip()


def _extract_authors(work: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for authorship in work.get("authorships", []):
        name = ((authorship or {}).get("author") or {}).get("display_name", "")
        if name and name not in names:
            names.append(name)
    return names


def search_openalex(queries: list[str], keywords: list[str], max_results: int) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    works: list[dict[str, Any]] = []
    selected_query = ""
    attempted_queries: list[dict[str, Any]] = []

    for query in queries:
        if not query.strip():
            continue

        params = {
            "search": query,
            "per-page": str(max_results),
            "sort": "relevance_score:desc",
        }
        url = f"{BASE_URL}?{urlencode(params)}"
        payload = _get_json(url)
        works = payload.get("results", [])
        attempted_queries.append({"query": query, "count": len(works)})
        if works:
            selected_query = query
            break

    normalized: list[dict[str, Any]] = []
    for work in works:
        abstract = _decode_abstract(work.get("abstract_inverted_index"))
        summary = abstract or (work.get("title") or "")
        doi_url = work.get("doi") or ""
        primary_location = work.get("primary_location") or {}
        source_url = (
            (primary_location.get("landing_page_url") or "")
            or (primary_location.get("pdf_url") or "")
            or doi_url
            or (work.get("id") or "")
        )

        normalized.append(
            {
                "openalex_id": work.get("id", ""),
                "doi": doi_url,
                "title": work.get("title", ""),
                "abstract": abstract,
                "summary": summary,
                "evidence_sentences": extract_evidence_sentences(summary, keywords),
                "authors": _extract_authors(work),
                "year": work.get("publication_year"),
                "publication_year": work.get("publication_year"),
                "publication_date": work.get("publication_date", ""),
                "type": work.get("type", ""),
                "source_url": source_url,
                "query_keywords": keywords,
                "raw": work,
            }
        )

    return {
        "query": queries[0] if queries else "",
        "selected_query": selected_query,
        "attempted_queries": attempted_queries,
        "records": normalized,
        "payload": payload,
    }
