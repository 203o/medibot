from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4
import re
import os
import json

from ingestion_api.clients.clinicaltrials import search_clinical_trials
from ingestion_api.clients.openalex import search_openalex
from ingestion_api.clients.pubmed import search_pubmed
from ingestion_api.schemas import IngestRequest, utc_now_iso
from ingestion_api.services.query_expansion import expand_query_hf
from ingestion_api.services.semantic_retrieval import semantic_index_and_search
from ingestion_api.storage.json_store import ensure_dir, write_json

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "during", "for", "from",
    "how", "i", "if", "in", "into", "is", "it", "of", "on", "or", "should",
    "the", "to", "what", "when", "with", "can", "my", "your", "while"
}

INTENT_SYNONYMS = {
    "hydration": ["hydration", "fluids", "fluid intake", "oral rehydration", "water"],
    "water": ["water", "hydration", "fluids", "oral fluids"],
    "vomiting": ["vomiting", "emesis", "nausea"],
    "fever": ["fever", "febrile", "temperature"],
    "research_lookup": ["systematic review", "meta-analysis", "clinical trial", "review"],
    "care_guidance": ["guidance", "management", "supportive care", "treatment"],
    "clinical_question": ["clinical", "management", "treatment"],
    "treatment": ["treatment", "therapy", "management"],
}

OPENALEX_EXPLORATION_CUES = {
    "research",
    "literature",
    "landscape",
    "exploration",
    "explore",
    "overview",
    "review",
    "summary",
}


def _tokenize(value: str) -> list[str]:
    return [
        token for token in re.split(r"[^a-z0-9]+", (value or "").lower())
        if len(token) > 2 and token not in STOPWORDS
    ]


def _expand_intent_tokens(tokens: list[str]) -> list[str]:
    expanded: list[str] = []
    for token in tokens:
        if token not in expanded:
            expanded.append(token)
        for synonym in INTENT_SYNONYMS.get(token, []):
            if synonym not in expanded:
                expanded.append(synonym)
    return expanded


def _unique_nonempty(values: list[str]) -> list[str]:
    unique_values: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in unique_values:
            unique_values.append(normalized)
    return unique_values


def build_query(payload: IngestRequest) -> str:
    return build_heuristic_query_fallbacks(payload)[0]


def build_heuristic_query_fallbacks(payload: IngestRequest) -> list[str]:
    disease = payload.medical_context.disease.strip()
    intent = payload.medical_context.intent.strip()
    location = (payload.medical_context.location or "").strip()
    intent_tokens = _expand_intent_tokens(_tokenize(intent))
    location_tokens = _tokenize(location)

    focused_clauses: list[str] = []
    if disease:
        focused_clauses.append(disease)
    focused_clauses.extend(intent_tokens[:4])

    if any(token in {"hydration", "water", "fluids"} for token in intent_tokens):
        focused_clauses.extend(["supportive care", "oral rehydration"])
    if any(token in {"research", "trial", "study", "review", "research_lookup"} for token in intent_tokens):
        focused_clauses.extend(["systematic review", "clinical trial"])

    focused_terms = _unique_nonempty(focused_clauses[1:])[:6]

    candidates = [
        " ".join(part for part in [disease, " ".join(focused_terms), location] if part).strip(),
        " ".join(part for part in [disease, " ".join(focused_terms)] if part).strip(),
        " ".join(part for part in [disease, " ".join(intent_tokens[:3]), "treatment"] if part).strip(),
        " ".join(part for part in [disease, *location_tokens[:2]] if part).strip(),
        disease,
    ]
    unique_candidates: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in unique_candidates:
            unique_candidates.append(candidate)
    return unique_candidates


def _merge_query_candidates(original_query: str, expanded_queries: list[str], fallback_queries: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()

    for query in [original_query, *expanded_queries, *fallback_queries]:
        normalized = " ".join((query or "").split()).strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(normalized)
    return merged


def build_query_fallbacks(payload: IngestRequest) -> list[str]:
    heuristic = build_heuristic_query_fallbacks(payload)
    query = heuristic[0]
    expansion = expand_query_hf(
        query=query,
        disease=payload.medical_context.disease,
        intent=payload.medical_context.intent,
        location=payload.medical_context.location or "",
    )
    return _merge_query_candidates(
        original_query=query,
        expanded_queries=expansion.get("expanded_queries", []),
        fallback_queries=heuristic[1:],
    )


def should_use_llm_expansion(payload: IngestRequest, query: str) -> bool:
    conditional = os.getenv("LLM_QUERY_EXPANSION_CONDITIONAL", "true").strip().lower() in {"1", "true", "yes", "on"}
    if not conditional:
        return True

    q_tokens = _tokenize(query)
    if len(q_tokens) <= 6:
        return True

    intent = (payload.medical_context.intent or "").lower()
    ambiguous_cues = ["recheck", "rechek", "more info", "more informed", "what about", "how about", "explain", "elaborate"]
    return any(cue in intent for cue in ambiguous_cues)


def build_keywords(payload: IngestRequest) -> list[str]:
    disease = payload.medical_context.disease.strip().lower()
    intent_tokens = _expand_intent_tokens(_tokenize(payload.medical_context.intent.strip()))
    location_tokens = _tokenize((payload.medical_context.location or "").strip())

    keywords: list[str] = []
    for token in [disease, *intent_tokens, *location_tokens]:
        normalized = token.strip().lower()
        if normalized and normalized not in keywords:
            keywords.append(normalized)
    return keywords[:16]


def _should_query_openalex(payload: IngestRequest, pubmed_count: int) -> tuple[bool, str]:
    sparse_threshold = int(os.getenv("OPENALEX_SPARSE_THRESHOLD", "12"))
    if pubmed_count < sparse_threshold:
        return True, f"pubmed_sparse_lt_{sparse_threshold}"

    intent_tokens = set(_expand_intent_tokens(_tokenize(payload.medical_context.intent or "")))
    if intent_tokens.intersection(OPENALEX_EXPLORATION_CUES):
        return True, "exploration_intent"

    return False, "not_needed"


def _truncate_queries(values: list[str], max_chars: int = 180) -> list[str]:
    clipped: list[str] = []
    for value in values:
        text = str(value or "")
        if len(text) <= max_chars:
            clipped.append(text)
        else:
            clipped.append(f"{text[:max_chars]}...")
    return clipped


def _log_query_plan(
    run_id: str,
    original_query: str,
    expanded_queries: list[str],
    heuristic_fallbacks: list[str],
    final_queries: list[str],
    expansion: dict[str, Any],
) -> None:
    payload = {
        "event": "query_plan",
        "run_id": run_id,
        "original_query": original_query,
        "expanded_queries": _truncate_queries(expanded_queries),
        "heuristic_fallbacks": _truncate_queries(heuristic_fallbacks),
        "final_queries": _truncate_queries(final_queries),
        "expansion_enabled": bool(expansion.get("enabled")),
        "expansion_attempted": bool(expansion.get("attempted")),
        "expansion_reason": expansion.get("reason", ""),
        "counts": {
            "expanded": len(expanded_queries),
            "heuristic": len(heuristic_fallbacks),
            "final": len(final_queries),
        },
    }
    print(f"[ingestion] {json.dumps(payload, ensure_ascii=False)}")


def ingest_sources(
    payload: IngestRequest,
    base_data_dir: Path,
    pubmed_tool: str,
    pubmed_email: str,
) -> dict[str, Any]:
    run_id = uuid4().hex
    stored_at = utc_now_iso()
    heuristic_fallbacks = build_heuristic_query_fallbacks(payload)
    query = heuristic_fallbacks[0]
    expansion = {
        "enabled": False,
        "attempted": False,
        "provider": "huggingface",
        "model": "",
        "expanded_queries": [],
        "reason": "conditional_skip",
    }
    if should_use_llm_expansion(payload, query):
        expansion = expand_query_hf(
            query=query,
            disease=payload.medical_context.disease,
            intent=payload.medical_context.intent,
            location=payload.medical_context.location or "",
        )
    query_fallbacks = _merge_query_candidates(
        original_query=query,
        expanded_queries=expansion.get("expanded_queries", []),
        fallback_queries=heuristic_fallbacks[1:],
    )
    _log_query_plan(
        run_id=run_id,
        original_query=query,
        expanded_queries=expansion.get("expanded_queries", []),
        heuristic_fallbacks=heuristic_fallbacks,
        final_queries=query_fallbacks,
        expansion=expansion,
    )
    keywords = build_keywords(payload)
    output_dir = ensure_dir(base_data_dir / stored_at[:10] / run_id)

    pubmed_result: dict[str, Any] = {"records": []}
    trials_result: dict[str, Any] = {"records": []}
    openalex_result: dict[str, Any] = {"records": []}

    file_map: dict[str, str] = {}

    if "pubmed" in payload.sources:
        pubmed_result = search_pubmed(query_fallbacks, keywords, payload.max_results, pubmed_tool, pubmed_email)
        file_map["pubmed"] = write_json(output_dir / "pubmed.raw.json", pubmed_result)

    if "clinicaltrials" in payload.sources:
        trials_result = search_clinical_trials(query_fallbacks, keywords, payload.medical_context.location, payload.max_results)
        file_map["clinicaltrials"] = write_json(output_dir / "clinicaltrials.raw.json", trials_result)

    openalex_policy_reason = "not_requested"
    if "openalex" in payload.sources:
        should_query_openalex, openalex_policy_reason = _should_query_openalex(
            payload,
            len(pubmed_result.get("records", [])),
        )
    else:
        should_query_openalex = False

    if should_query_openalex:
        openalex_result = search_openalex(query_fallbacks, keywords, payload.max_results)
        file_map["openalex"] = write_json(output_dir / "openalex.raw.json", openalex_result)

    semantic_top_k = max(payload.max_results, int(os.getenv("FAISS_TOP_K", "80")))
    semantic_top_k = min(max(1, semantic_top_k), 300)

    semantic = semantic_index_and_search(
        query=query,
        pubmed_records=pubmed_result.get("records", []),
        clinical_trials_records=trials_result.get("records", []),
        openalex_records=openalex_result.get("records", []),
        top_k=semantic_top_k,
    )
    file_map["semantic"] = write_json(output_dir / "semantic.raw.json", semantic)

    combined_records = {
        "query": query,
        "query_fallbacks": query_fallbacks,
        "heuristic_fallbacks": heuristic_fallbacks,
        "expanded_queries": expansion.get("expanded_queries", []),
        "query_expansion": expansion,
        "keywords": keywords,
        "medical_context": payload.model_dump(),
        "pubmed_records": pubmed_result.get("records", []),
        "clinical_trials_records": trials_result.get("records", []),
        "openalex_records": openalex_result.get("records", []),
        "semantic_hits": semantic.get("grouped_hits", []),
    }
    file_map["combined"] = write_json(output_dir / "combined.records.json", combined_records)

    manifest = {
        "run_id": run_id,
        "stored_at": stored_at,
        "query": query,
        "query_fallbacks": query_fallbacks,
        "heuristic_fallbacks": heuristic_fallbacks,
        "expanded_queries": expansion.get("expanded_queries", []),
        "keywords": keywords,
        "sources": payload.sources,
        "counts": {
            "pubmed": len(pubmed_result.get("records", [])),
            "clinicaltrials": len(trials_result.get("records", [])),
            "openalex": len(openalex_result.get("records", [])),
            "semantic_hits": len(semantic.get("grouped_hits", [])),
            "indexed_chunks": semantic.get("indexed_chunks", 0),
        },
        "policy": {
            "openalex_queried": should_query_openalex,
            "openalex_reason": openalex_policy_reason,
            "openalex_sparse_threshold": int(os.getenv("OPENALEX_SPARSE_THRESHOLD", "12")),
        },
        "query_expansion": expansion,
        "files": file_map,
    }
    manifest_path = write_json(output_dir / "manifest.json", manifest)

    return {
        "run_id": run_id,
        "stored_at": stored_at,
        "query": query,
        "sources": payload.sources,
        "pubmed_count": len(pubmed_result.get("records", [])),
        "clinical_trials_count": len(trials_result.get("records", [])),
        "openalex_count": len(openalex_result.get("records", [])),
        "output_dir": str(output_dir),
        "manifest_path": manifest_path,
    }
