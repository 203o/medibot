from __future__ import annotations

from typing import Any

from ingestion_api.services.chunking import build_chunks
from ingestion_api.services.embeddings import embed_texts
from ingestion_api.services.faiss_store import FaissStore


def aggregate_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}

    for match in matches:
        metadata = match.get("metadata", {})
        key = (metadata.get("source", ""), metadata.get("doc_id", ""))
        if key not in grouped:
            grouped[key] = {
                "source": metadata.get("source", ""),
                "doc_id": metadata.get("doc_id", ""),
                "title": metadata.get("title", ""),
                "study_type": metadata.get("study_type", ""),
                "year": metadata.get("year", ""),
                "url": metadata.get("url", ""),
                "semantic_score": float(match.get("score", 0.0)),
                "matched_sentences": [metadata.get("text", "")] if metadata.get("text") else [],
            }
        else:
            grouped[key]["semantic_score"] = max(grouped[key]["semantic_score"], float(match.get("score", 0.0)))
            sentence = metadata.get("text", "")
            if sentence and sentence not in grouped[key]["matched_sentences"]:
                grouped[key]["matched_sentences"].append(sentence)

    return sorted(grouped.values(), key=lambda item: item["semantic_score"], reverse=True)


def semantic_index_and_search(
    query: str,
    pubmed_records: list[dict[str, Any]],
    clinical_trials_records: list[dict[str, Any]],
    openalex_records: list[dict[str, Any]] | None = None,
    top_k: int = 120,
) -> dict[str, Any]:
    store = FaissStore()
    if not store.is_enabled():
        return {
            "enabled": False,
            "indexed_chunks": 0,
            "matches": [],
            "grouped_hits": [],
            "error": "faiss_disabled",
        }

    try:
        chunks = build_chunks(pubmed_records, clinical_trials_records, openalex_records or [])
        indexed_count = 0
        if chunks:
            chunk_embeddings = embed_texts([chunk["text"] for chunk in chunks])
            indexed_count = store.upsert_chunks(chunks, chunk_embeddings)

        query_embedding = embed_texts([query])[0]
        query_response = store.query(query_embedding, top_k=top_k)
    except RuntimeError as error:
        return {
            "enabled": False,
            "indexed_chunks": 0,
            "matches": [],
            "grouped_hits": [],
            "error": str(error),
        }

    matches = []
    for match in query_response.get("matches", []):
        matches.append(
            {
                "id": match.get("id", ""),
                "score": match.get("score", 0.0),
                "metadata": match.get("metadata", {}) or {},
            }
        )

    return {
        "enabled": True,
        "indexed_chunks": indexed_count,
        "matches": matches,
        "grouped_hits": aggregate_matches(matches),
    }
