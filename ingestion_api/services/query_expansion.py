from __future__ import annotations

from typing import Any
import json
import os
import re


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _safe_json_array(text: str) -> list[str]:
    if not text:
        return []
    candidate = text.strip()
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            return [str(item) for item in parsed if isinstance(item, str)]
    except json.JSONDecodeError:
        pass

    match = re.search(r"\[[\s\S]*\]", candidate)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
        if isinstance(parsed, list):
            return [str(item) for item in parsed if isinstance(item, str)]
    except json.JSONDecodeError:
        return []
    return []


def _sanitize_expansions(original_query: str, expanded: list[str], max_expansions: int) -> list[str]:
    normalized_original = original_query.strip().lower()
    deduped: list[str] = []
    seen: set[str] = set()

    for query in expanded:
        value = " ".join(str(query).split()).strip()
        if not value:
            continue
        normalized = value.lower()
        if normalized == normalized_original:
            continue
        if len(value) < 8 or len(value) > 220:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(value)
        if len(deduped) >= max_expansions:
            break
    return deduped


def expand_query_hf(
    query: str,
    disease: str,
    intent: str,
    location: str = "",
) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_QUERY_EXPANSION"), default=False)
    if not enabled:
        return {
            "enabled": False,
            "attempted": False,
            "provider": "huggingface",
            "model": "",
            "expanded_queries": [],
            "reason": "disabled",
        }

    token = os.getenv("HF_TOKEN", "").strip()
    if not token:
        return {
            "enabled": True,
            "attempted": False,
            "provider": "huggingface",
            "model": "",
            "expanded_queries": [],
            "reason": "missing_hf_token",
        }

    max_expansions = max(1, min(int(os.getenv("QUERY_EXPANSION_MAX", "3")), 6))
    model = os.getenv("HF_QUERY_EXPANSION_MODEL", "meta-llama/Llama-3.1-8B-Instruct").strip()
    timeout = max(3.0, min(float(os.getenv("QUERY_EXPANSION_TIMEOUT_SEC", "8")), 30.0))

    try:
        from huggingface_hub import InferenceClient
    except Exception:
        return {
            "enabled": True,
            "attempted": False,
            "provider": "huggingface",
            "model": model,
            "expanded_queries": [],
            "reason": "huggingface_hub_unavailable",
        }

    prompt = (
        "Generate alternative medical literature search queries.\n"
        "Constraints:\n"
        "- Keep the same clinical meaning.\n"
        "- Prefer epidemiology and evidence-synthesis wording.\n"
        f"- Return exactly a JSON array of {max_expansions} strings.\n"
        "- No prose, no markdown.\n\n"
        f'Original query: "{query}"\n'
        f'Disease: "{disease}"\n'
        f'Intent: "{intent}"\n'
        f'Location: "{location}"\n'
    )

    try:
        client = InferenceClient(token=token, timeout=timeout)
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You output only valid JSON arrays of strings."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=220,
        )
        content = (completion.choices[0].message.content or "").strip()
        parsed = _safe_json_array(content)
        expanded_queries = _sanitize_expansions(query, parsed, max_expansions)
        return {
            "enabled": True,
            "attempted": True,
            "provider": "huggingface",
            "model": model,
            "expanded_queries": expanded_queries,
            "reason": "ok",
        }
    except Exception as error:
        return {
            "enabled": True,
            "attempted": True,
            "provider": "huggingface",
            "model": model,
            "expanded_queries": [],
            "reason": f"error:{type(error).__name__}",
        }
