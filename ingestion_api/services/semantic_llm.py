from __future__ import annotations

from typing import Any
import json
import os
import re
from textwrap import shorten


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _extract_json_object(text: str) -> dict[str, Any]:
    if not text:
        return {}
    candidate = text.strip()
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", candidate)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        return {}
    return {}


def _get_client(timeout_sec: float):
    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        from groq import Groq

        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return None
        return Groq(api_key=token)

    from huggingface_hub import InferenceClient

    token = os.getenv("HF_TOKEN", "").strip()
    if not token:
        return None
    return InferenceClient(token=token, timeout=timeout_sec)


def _chat_json(
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    temperature: float = 0.1,
) -> dict[str, Any]:
    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    timeout = max(3.0, min(float(os.getenv("LLM_SEMANTIC_TIMEOUT_SEC", "15")), 45.0))
    client = _get_client(timeout)
    if not client:
        if provider == "groq":
            raise RuntimeError("missing_groq_api_key")
        raise RuntimeError("missing_hf_token")

    if provider == "groq":
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = (completion.choices[0].message.content or "").strip()
    else:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        content = (completion.choices[0].message.content or "").strip()
    return _extract_json_object(content)

def _trim_text(value: Any, max_chars: int) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return shorten(text, width=max_chars, placeholder="...")


def _extract_citation_id(value: Any) -> str:
    if isinstance(value, (str, int, float)):
        return str(value).strip()
    if not isinstance(value, dict):
        return ""
    for key in ("id", "citation", "citation_id", "source_id", "pmid", "trial_id"):
        candidate = value.get(key)
        if isinstance(candidate, (str, int, float)):
            normalized = str(candidate).strip()
            if normalized:
                return normalized
    return ""


def _normalize_citation_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    for value in values:
        citation_id = _extract_citation_id(value)
        if citation_id and citation_id not in normalized:
            normalized.append(citation_id)
    return normalized


def _normalize_claims(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []

    normalized_claims: list[dict[str, Any]] = []
    for claim in values:
        if not isinstance(claim, dict):
            continue
        text = str(claim.get("text") or claim.get("statement") or claim.get("claim") or "").strip()
        citations = _normalize_citation_list(
            []
            + (claim.get("citations") if isinstance(claim.get("citations"), list) else [])
            + (claim.get("citation_ids") if isinstance(claim.get("citation_ids"), list) else [])
            + (claim.get("sources") if isinstance(claim.get("sources"), list) else [])
        )
        normalized_claims.append({"text": text, "citations": citations})
    return normalized_claims

def _first_non_empty(parsed: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = parsed.get(key)
        text = str(value or "").strip()
        if text:
            return text
    return ""

def _normalize_evidence_points(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    for value in values:
        if isinstance(value, dict):
            text = str(value.get("text") or value.get("point") or value.get("summary") or "").strip()
            citation = str(value.get("citation") or value.get("id") or "").strip()
            line = f"{text} [{citation}]".strip() if citation else text
        else:
            line = str(value or "").strip()
        if line:
            normalized.append(line)
    return normalized


def classify_documents(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_SEMANTIC_CLASSIFIER"), default=True)
    if not enabled:
        return {"enabled": False, "reason": "disabled", "results": []}

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_groq_api_key", "results": []}
        model = os.getenv("GROQ_SEMANTIC_MODEL", os.getenv("GROQ_MODEL", "llama3-8b-8192")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_hf_token", "results": []}
        model = os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct").strip()

    docs = payload.get("documents", []) or []
    max_docs = max(1, min(int(os.getenv("LLM_CLASSIFY_MAX_DOCS", "24")), 40))

    system_prompt = (
        "You are a strict biomedical relevance and study-type classifier. "
        "Return only JSON object with keys: relevant, reason, tier_suggestion, doc_type, focus, confidence."
    )
    results: list[dict[str, Any]] = []

    for doc in docs[:max_docs]:
        user_prompt = (
            "Classify the document for this medical question.\n"
            f"Query: {payload.get('query', '')}\n"
            f"Disease: {payload.get('disease', '')}\n"
            f"Intent: {payload.get('intent', '')}\n"
            f"Retrieval mode: {payload.get('retrieval_mode', '')}\n\n"
            f"Document source: {doc.get('source', '')}\n"
            f"Title: {doc.get('title', '')}\n"
            f"Study type: {doc.get('study_type', '')}\n"
            f"Year: {doc.get('year', '')}\n"
            f"Snippet: {doc.get('snippet', '')}\n\n"
            "Rules:\n"
            "- relevant=true only if it directly addresses the question.\n"
            "- tier_suggestion: 1,2,3,4 where 1 is strongest direct evidence.\n"
            "- doc_type one of: review, meta_analysis, randomized_controlled_trial, interventional_trial, observational, trial_registry, guideline, other.\n"
            "- focus one of: treatment, supportive_care, epidemiology, ongoing_studies, diagnosis, prevention, other.\n"
            "- confidence between 0 and 1.\n"
            "Output JSON only."
        )
        try:
            parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=220)
        except Exception as error:
            results.append(
                {
                    "id": doc.get("id", ""),
                    "relevant": None,
                    "reason": f"error:{type(error).__name__}",
                    "tier_suggestion": None,
                    "doc_type": "",
                    "focus": "",
                    "confidence": None,
                }
            )
            continue

        tier_value = parsed.get("tier_suggestion")
        try:
            tier_value = int(tier_value)
            if tier_value < 1 or tier_value > 4:
                tier_value = None
        except Exception:
            tier_value = None

        confidence = parsed.get("confidence")
        try:
            confidence = float(confidence)
            if confidence < 0 or confidence > 1:
                confidence = None
        except Exception:
            confidence = None

        results.append(
            {
                "id": doc.get("id", ""),
                "relevant": parsed.get("relevant") if isinstance(parsed.get("relevant"), bool) else None,
                "reason": str(parsed.get("reason", "")),
                "tier_suggestion": tier_value,
                "doc_type": str(parsed.get("doc_type", "")),
                "focus": str(parsed.get("focus", "")),
                "confidence": confidence,
            }
        )

    return {"enabled": True, "reason": "ok", "results": results}


def synthesize_tiered(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_TIERED_SYNTHESIS"), default=True)
    if not enabled:
        return {
            "enabled": False,
            "reason": "disabled",
            "direct_answer": "",
            "supporting_explanation": "",
            "claims": [],
            "citations": [],
            "answer": "",
            "evidence_mixed": False,
            "conflict_reason": "",
            "conflict_details": [],
        }

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {
                "enabled": False,
                "reason": "missing_groq_api_key",
                "direct_answer": "",
                "supporting_explanation": "",
                "claims": [],
                "citations": [],
                "answer": "",
                "evidence_mixed": False,
                "conflict_reason": "",
                "conflict_details": [],
            }
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {
                "enabled": False,
                "reason": "missing_hf_token",
                "direct_answer": "",
                "supporting_explanation": "",
                "claims": [],
                "citations": [],
                "answer": "",
                "evidence_mixed": False,
                "conflict_reason": "",
                "conflict_details": [],
            }

    primary_evidence = payload.get("primary_evidence", []) or []
    supplemental_evidence = payload.get("supplemental_evidence", []) or []
    if not primary_evidence and not supplemental_evidence:
        return {
            "enabled": False,
            "reason": "no_evidence",
            "direct_answer": "",
            "supporting_explanation": "",
            "claims": [],
            "citations": [],
            "answer": "",
            "evidence_mixed": False,
            "conflict_reason": "",
            "conflict_details": [],
        }

    max_items = max(2, min(int(os.getenv("LLM_SYNTHESIS_MAX_CHUNKS", "6")), 12))
    max_tokens = max(220, min(int(os.getenv("LLM_SYNTHESIS_MAX_TOKENS", "420")), 700))
    title_chars = max(80, min(int(os.getenv("LLM_SYNTHESIS_TITLE_CHARS", "110")), 220))
    summary_chars = max(100, min(int(os.getenv("LLM_SYNTHESIS_SUMMARY_CHARS", "180")), 320))
    primary_evidence = primary_evidence[:max_items]
    supplemental_evidence = supplemental_evidence[:max_items]

    if provider == "groq":
        primary_model = os.getenv("GROQ_SYNTHESIS_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
        models = [primary_model]
    else:
        primary_model = os.getenv("HF_SYNTHESIS_MODEL", "meta-llama/Llama-3.1-8B-Instruct").strip()
        fallback_models = [
            item.strip()
            for item in os.getenv("HF_SYNTHESIS_MODEL_FALLBACKS", "Qwen/Qwen2.5-7B-Instruct").split(",")
            if item.strip()
        ]
        models = [primary_model, *fallback_models]
    tone_mode = str(payload.get("tone_mode") or os.getenv("CHAT_TONE_MODE", "clinical")).strip().lower()
    if tone_mode not in {"clinical", "conversational", "concise"}:
        tone_mode = "clinical"

    tone_rules = {
        "clinical": (
            "- Use a calm, professional, plain-language clinical tone.\n"
            "- Avoid speculation, hype, and emotional wording.\n"
            "- Use short clear paragraphs and neutral language."
        ),
        "conversational": (
            "- Use friendly but professional language.\n"
            "- Keep explanations clear, easy to follow, and user-facing.\n"
            "- Avoid slang, jokes, and emojis."
        ),
        "concise": (
            "- Be brief and high-signal.\n"
            "- Prefer compact sentences and minimal filler.\n"
            "- Keep uncertainty statements short and precise while still explaining the takeaway."
        ),
    }

    system_prompt = (
        "You are a medically cautious evidence explainer. "
        "Turn the supplied evidence into a user-facing answer that explains the takeaway in plain language. "
        "Use PRIMARY evidence as the main basis. Use SUPPLEMENTAL only to qualify. "
        "Never invent facts. Do not use outside knowledge. Return JSON only.\n"
        f"Tone mode: {tone_mode}\n"
        f"{tone_rules[tone_mode]}"
    )
    research_mode = bool(payload.get("research_mode", False))
    research_focus = payload.get("research_focus", []) or []
    if not isinstance(research_focus, list):
        research_focus = []
    research_focus = [str(item).strip() for item in research_focus if str(item).strip()][:6]
    case_anchors = payload.get("case_anchors", {}) or {}
    if not isinstance(case_anchors, dict):
        case_anchors = {}
    catalog_ids = list((payload.get("citation_catalog", {}) or {}).keys())
    def _line(item: dict[str, Any]) -> str:
        return (
            f"- ID:{item.get('id','')} | "
            f"Title:{_trim_text(item.get('title',''), title_chars)} | "
            f"Summary:{_trim_text(item.get('summary',''), summary_chars)} | "
            f"Strength:{item.get('evidence_strength','')}"
        )

    user_prompt = (
        "Answer using ONLY provided evidence.\n"
        f"Question: {payload.get('query', '')}\n"
        f"Disease: {payload.get('disease', '')}\n"
        f"Intent: {payload.get('intent', '')}\n"
        f"Retrieval mode: {payload.get('retrieval_mode', '')}\n\n"
        "[PRIMARY EVIDENCE]\n"
        + "\n".join(
            _line(item)
            for item in primary_evidence
        )
        + "\n\n[SUPPLEMENTAL EVIDENCE]\n"
        + "\n".join(
            _line(item)
            for item in supplemental_evidence
        )
        + "\n\n[CONFLICT HINTS]\n"
        + "\n".join(f"- {hint}" for hint in (payload.get("conflict_hints", []) or []))
        + f"\nConflict level hint: {payload.get('conflict_level', 'none')}\n"
        + f"\nAllowed citation IDs: {', '.join(catalog_ids)}\n"
        + (f"\nResearch focus hints: {', '.join(research_focus)}\n" if research_focus else "")
        + (f"\nCase anchors: {json.dumps(case_anchors)}\n" if case_anchors else "")
        + "\n\nOutput JSON with keys:\n"
        '- direct_answer (string, one-to-two sentence plain-language answer)\n'
        '- supporting_explanation (string, explain what the evidence means and why it matters)\n'
        '- evidence_points (array of 3-5 concise evidence bullets that summarize the pattern, not paper wording)\n'
        '- research_landscape (array of concise bullets about broader directions and trends)\n'
        '- relevant_trials (array of concise bullets, include trial relevance to this case)\n'
        '- progression_research (array of concise bullets about progression or next-step research)\n'
        '- monitoring_research (array of concise bullets, e.g., ctDNA/MRD/imaging)\n'
        '- evidence_gaps (array of concise bullets)\n'
        '- study_spotlight (object: {id,title,population,key_finding,limitation})\n'
        '- uncertainties (array of 1-3 remaining uncertainties)\n'
        '- claims (array of {text:string, citations:[id,...]})\n'
        '- citations (array of ids)\n'
        '- evidence_mixed (boolean)\n'
        '- conflict_reason (string)\n'
        '- conflict_details (array of strings)\n'
        "Rules:\n"
        "- Base answer primarily on PRIMARY evidence.\n"
        "- Use SUPPLEMENTAL only to support or qualify.\n"
        "- Do not merge multiple citations into one claim unless they support the same statement.\n"
        "- Every claim must have at least one citation from allowed IDs.\n"
        "- If evidence is insufficient, say so clearly.\n"
        "- If studies disagree, state evidence is mixed and explain likely reasons.\n"
        "- Prefer a detailed response that synthesizes the evidence into a practical takeaway.\n"
        "- Include study-level specifics only when they help the user understand the takeaway.\n"
        "- Avoid article-style paraphrase or sentence-by-sentence repetition from the papers.\n"
        "- Do not start the answer with labels like 'Primary evidence' or 'Additional primary evidence'."
        + "\n- Keep tone consistent with the requested tone mode."
        + ("\n- RESEARCH DISCOVERY MODE is active: summarize relevant research areas, active/ongoing trials, emerging therapies, and evidence gaps."
           "\n- Do NOT provide direct treatment recommendations or clinical decisions."
           "\n- Frame applicability to the patient state only as research relevance."
           "\n- HARD CASE ANCHOR RULE: use stage/setting, prior regimen, biomarkers, and current phase from case anchors."
           "\n- Reject studies that do not align with these anchors."
           "\n- Avoid generic biology/pathway-only discussion unless directly tied to the current treatment setting."
           if research_mode else "")
    )

    parsed: dict[str, Any] = {}
    last_error: Exception | None = None
    last_error_model = ""
    attempted_models: list[str] = []
    attempt_errors: list[str] = []
    for model_name in models:
        attempted_models.append(model_name)
        try:
            candidate = _chat_json(model_name, system_prompt, user_prompt, max_tokens=max_tokens, temperature=0.1)
            if not isinstance(candidate, dict) or not candidate:
                raise ValueError("empty_or_non_json_response")
            has_signal = any(
                bool(str(candidate.get(key, "")).strip())
                for key in ("direct_answer", "supporting_explanation", "answer")
            ) or bool(candidate.get("claims")) or bool(candidate.get("evidence_points"))
            if not has_signal:
                raise ValueError("no_structured_signal")
            parsed = candidate
            last_error = None
            break
        except Exception as error:
            last_error = error
            last_error_model = model_name
            message = str(error).replace("\n", " ")
            attempt_errors.append(f"{model_name}:{type(error).__name__}:{_trim_text(message, 160)}")
            continue

    if last_error is not None:
        attempted = ",".join(attempted_models) if attempted_models else "none"
        error_type = type(last_error).__name__
        reason = f"error:{error_type}"
        if last_error_model:
            reason = f"{reason}@{last_error_model}|attempted={attempted}|details={' || '.join(attempt_errors)}"
        return {
            "enabled": False,
            "reason": reason,
            "direct_answer": "",
            "supporting_explanation": "",
            "claims": [],
            "citations": [],
            "answer": "",
            "evidence_mixed": False,
            "conflict_reason": "",
            "conflict_details": [],
        }

    details = parsed.get("conflict_details")
    if not isinstance(details, list):
        details = []
    evidence_points = _normalize_evidence_points(parsed.get("evidence_points"))
    research_landscape = _normalize_evidence_points(parsed.get("research_landscape"))
    relevant_trials = _normalize_evidence_points(parsed.get("relevant_trials"))
    progression_research = _normalize_evidence_points(parsed.get("progression_research"))
    monitoring_research = _normalize_evidence_points(parsed.get("monitoring_research"))
    evidence_gaps = _normalize_evidence_points(parsed.get("evidence_gaps"))
    uncertainties = parsed.get("uncertainties")
    if not isinstance(uncertainties, list):
        uncertainties = []
    spotlight = parsed.get("study_spotlight")
    if not isinstance(spotlight, dict):
        spotlight = {}
    claims = _normalize_claims(parsed.get("claims"))
    citations = _normalize_citation_list(parsed.get("citations"))
    if not citations:
        citations = _normalize_citation_list(
            [citation for claim in claims for citation in claim.get("citations", [])]
        )

    direct_answer = _first_non_empty(parsed, ["direct_answer", "directAnswer", "directanswer", "answer"])
    supporting_explanation = _first_non_empty(parsed, ["supporting_explanation", "supportingExplanation", "support", "explanation"])
    if not direct_answer and claims:
        direct_answer = claims[0].get("text", "")
        if len(claims) > 1 and not supporting_explanation:
            supporting_explanation = claims[1].get("text", "")
    answer = " ".join(part for part in [direct_answer, supporting_explanation] if part).strip()

    return {
        "enabled": True,
        "reason": "ok",
        "direct_answer": direct_answer,
        "supporting_explanation": supporting_explanation,
        "evidence_points": evidence_points,
        "research_landscape": research_landscape,
        "relevant_trials": relevant_trials,
        "progression_research": progression_research,
        "monitoring_research": monitoring_research,
        "evidence_gaps": evidence_gaps,
        "study_spotlight": spotlight,
        "uncertainties": [str(item).strip() for item in uncertainties if str(item).strip()],
        "claims": claims,
        "citations": [str(item) for item in citations if str(item).strip()],
        "answer": answer,
        "evidence_mixed": bool(parsed.get("evidence_mixed", False)),
        "conflict_reason": str(parsed.get("conflict_reason", "")).strip(),
        "conflict_details": [str(item) for item in details if str(item).strip()],
    }


def refine_intent(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_INTENT_REFINER"), default=True)
    if not enabled:
        return {"enabled": False, "reason": "disabled"}

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_groq_api_key"}
        model = os.getenv("GROQ_INTENT_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_hf_token"}
        model = os.getenv("HF_INTENT_MODEL", os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct")).strip()

    system_prompt = (
        "You are a medical intent classifier. "
        "Return JSON only."
    )
    user_prompt = (
        "Classify this query intent.\n"
        f"Message: {payload.get('message', '')}\n"
        f"Disease: {payload.get('disease', '')}\n"
        f"Intent: {payload.get('intent', '')}\n"
        f"Location: {payload.get('location', '')}\n\n"
        "Return JSON keys:\n"
        "- is_medical (boolean)\n"
        "- intent_type (clinical_guidance|research_summary|risk_factor|causality|general_knowledge|ongoing_studies|intervention_landscape)\n"
        "- topic (string)\n"
        "- population (string)\n"
        "- reasoning_mode (evidence_only|hybrid)\n"
        "- confidence (0..1)\n"
        "- reason (string)\n"
    )
    try:
        parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=220, temperature=0.0)
    except Exception as error:
        return {
            "enabled": False,
            "reason": f"error:{type(error).__name__}",
        }

    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)
        if confidence < 0 or confidence > 1:
            confidence = 0.0
    except Exception:
        confidence = 0.0

    intent_type = str(parsed.get("intent_type", "")).strip().lower()
    allowed_types = {
        "clinical_guidance",
        "research_summary",
        "risk_factor",
        "causality",
        "general_knowledge",
        "ongoing_studies",
        "intervention_landscape",
    }
    if intent_type not in allowed_types:
        intent_type = "research_summary"

    reasoning_mode = str(parsed.get("reasoning_mode", "")).strip().lower()
    if reasoning_mode not in {"evidence_only", "hybrid"}:
        reasoning_mode = "evidence_only"

    is_medical = parsed.get("is_medical")
    is_medical = bool(is_medical) if isinstance(is_medical, bool) else True

    return {
        "enabled": True,
        "reason": "ok",
        "provider": provider,
        "model": model,
        "is_medical": is_medical,
        "intent_type": intent_type,
        "topic": str(parsed.get("topic", "")).strip(),
        "population": str(parsed.get("population", "")).strip(),
        "reasoning_mode": reasoning_mode,
        "confidence": confidence,
        "explanation": str(parsed.get("reason", "")).strip(),
    }


def infer_medical_context(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_CONTEXT_AUTOFILL"), default=True)
    message = str(payload.get("message", "")).strip()
    disease = str(payload.get("disease", "")).strip()
    location = str(payload.get("location", "")).strip()
    intent = str(payload.get("intent", "")).strip()

    if not message:
        return {
            "enabled": False,
            "reason": "empty_message",
            "disease": disease,
            "location": location,
            "confidence": 0.0,
            "provider": "",
            "model": "",
            "used_llm": False,
        }

    if disease and location:
        return {
            "enabled": True,
            "reason": "already_complete",
            "disease": disease,
            "location": location,
            "confidence": 1.0,
            "provider": "",
            "model": "",
            "used_llm": False,
        }

    if not enabled:
        return {
            "enabled": False,
            "reason": "disabled",
            "disease": disease,
            "location": location,
            "confidence": 0.0,
            "provider": "",
            "model": "",
            "used_llm": False,
        }

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_groq_api_key", "disease": disease, "location": location, "confidence": 0.0, "provider": provider, "model": "", "used_llm": False}
        model = os.getenv("GROQ_CONTEXT_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_hf_token", "disease": disease, "location": location, "confidence": 0.0, "provider": provider, "model": "", "used_llm": False}
        model = os.getenv("HF_CONTEXT_MODEL", os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct")).strip()

    system_prompt = (
        "You extract medical context from user questions for retrieval. "
        "Return JSON only."
    )
    user_prompt = (
        "Extract missing context from the query.\n"
        f"Message: {message}\n"
        f"Disease (existing): {disease}\n"
        f"Intent (existing): {intent}\n"
        f"Location (existing): {location}\n\n"
        "Rules:\n"
        "- Preserve existing non-empty fields.\n"
        "- Disease should be a concise clinical topic if present.\n"
        "- Location should be country/city/region if explicit.\n"
        "- If absent, return empty string.\n"
        "- Confidence 0..1.\n\n"
        "Return JSON keys:\n"
        "- disease\n"
        "- location\n"
        "- confidence\n"
        "- reason\n"
    )
    try:
        parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=160, temperature=0.0)
    except Exception as error:
        return {
            "enabled": False,
            "reason": f"error:{type(error).__name__}",
            "disease": disease,
            "location": location,
            "confidence": 0.0,
            "provider": provider,
            "model": model,
            "used_llm": False,
        }

    inferred_disease = str(parsed.get("disease", "")).strip() or disease
    inferred_location = str(parsed.get("location", "")).strip() or location
    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)
        if confidence < 0 or confidence > 1:
            confidence = 0.0
    except Exception:
        confidence = 0.0

    return {
        "enabled": True,
        "reason": str(parsed.get("reason", "")).strip() or "ok",
        "disease": inferred_disease,
        "location": inferred_location,
        "confidence": confidence,
        "provider": provider,
        "model": model,
        "used_llm": True,
    }


def expand_followup_query(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_QUERY_REFINER"), default=True)
    if not enabled:
        return {"enabled": False, "reason": "disabled", "expanded_query": ""}

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_groq_api_key", "expanded_query": ""}
        model = os.getenv("GROQ_QUERY_REFINER_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_hf_token", "expanded_query": ""}
        model = os.getenv("HF_QUERY_REFINER_MODEL", os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct")).strip()

    system_prompt = (
        "You expand short medical follow-up queries into precise retrieval queries. "
        "Return JSON only."
    )
    user_prompt = (
        "Expand the follow-up into a precise medical search query.\n"
        "Preserve disease, population, and geography.\n"
        "Do not change intent axis unless explicit.\n\n"
        f"Message: {payload.get('message', '')}\n"
        f"Disease: {payload.get('disease', '')}\n"
        f"Previous intent: {payload.get('previous_intent', '')}\n"
        f"Location: {payload.get('location', '')}\n"
        f"Base reconstructed query: {payload.get('base_query', '')}\n\n"
        "Return JSON:\n"
        "{\n"
        '  "expanded_query": "...",\n'
        '  "intent_axis": "treatment|epidemiology|comparison|risk_factor|causality",\n'
        '  "keywords": ["..."],\n'
        '  "reason": "..."\n'
        "}"
    )
    try:
        parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=180, temperature=0.0)
    except Exception as error:
        return {
            "enabled": False,
            "reason": f"error:{type(error).__name__}",
            "expanded_query": "",
            "intent_axis": "",
            "keywords": [],
        }

    expanded_query = " ".join(str(parsed.get("expanded_query", "")).split()).strip()
    intent_axis = str(parsed.get("intent_axis", "")).strip().lower()
    if intent_axis not in {"treatment", "epidemiology", "comparison", "risk_factor", "causality"}:
        intent_axis = ""
    keywords = parsed.get("keywords")
    if not isinstance(keywords, list):
        keywords = []
    keywords = [str(item).strip() for item in keywords if str(item).strip()][:8]

    return {
        "enabled": bool(expanded_query),
        "reason": "ok" if expanded_query else "empty_query",
        "expanded_query": expanded_query,
        "intent_axis": intent_axis,
        "keywords": keywords,
        "explanation": str(parsed.get("reason", "")).strip(),
        "provider": provider,
        "model": model,
    }


def classify_intent_attachment(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_LLM_INTENT_ATTACHMENT"), default=True)
    if not enabled:
        return {
            "enabled": False,
            "reason": "disabled",
            "attachment": "root",
            "intent": "",
            "query": "",
            "confidence": 0.0,
        }

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_groq_api_key", "attachment": "root", "intent": "", "query": "", "confidence": 0.0}
        model = os.getenv("GROQ_INTENT_ATTACHMENT_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {"enabled": False, "reason": "missing_hf_token", "attachment": "root", "intent": "", "query": "", "confidence": 0.0}
        model = os.getenv("HF_INTENT_ATTACHMENT_MODEL", os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct")).strip()

    system_prompt = (
        "You are an intent attachment classifier for a medical evidence chatbot. "
        "Return JSON only."
    )
    user_prompt = (
        "Given the context, decide whether the current message attaches to root intent, previous turn, "
        "introduces new sub-intent, or is out of scope.\n\n"
        f"Root intent: {payload.get('root_intent', '')}\n"
        f"Conversation summary: {payload.get('conversation_summary', '')}\n"
        f"Last turn intent: {payload.get('last_turn_intent', '')}\n"
        f"Last turn message: {payload.get('last_turn_message', '')}\n"
        f"Disease: {payload.get('disease', '')}\n"
        f"Location: {payload.get('location', '')}\n"
        f"Current message: {payload.get('message', '')}\n\n"
        "Return JSON keys:\n"
        "- attachment: root | previous_turn | new_subintent | out_of_scope\n"
        "- intent: normalized medical intent text\n"
        "- query: normalized retrieval query string\n"
        "- confidence: float between 0 and 1\n"
        "- reason: short explanation\n"
    )
    try:
        parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=220, temperature=0.0)
    except Exception as error:
        return {
            "enabled": False,
            "reason": f"error:{type(error).__name__}",
            "attachment": "root",
            "intent": "",
            "query": "",
            "confidence": 0.0,
        }

    attachment = str(parsed.get("attachment", "")).strip().lower()
    if attachment not in {"root", "previous_turn", "new_subintent", "out_of_scope"}:
        attachment = "root"
    intent = " ".join(str(parsed.get("intent", "")).split()).strip()
    query = " ".join(str(parsed.get("query", "")).split()).strip()
    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)
        if confidence < 0 or confidence > 1:
            confidence = 0.0
    except Exception:
        confidence = 0.0

    return {
        "enabled": True,
        "reason": "ok",
        "attachment": attachment,
        "intent": intent,
        "query": query,
        "confidence": confidence,
        "explanation": str(parsed.get("reason", "")).strip(),
        "provider": provider,
        "model": model,
    }


def reasoning_head(payload: dict[str, Any]) -> dict[str, Any]:
    enabled = _as_bool(os.getenv("ENABLE_UNIFIED_REASONING_HEAD"), default=True)
    if not enabled:
        return {
            "enabled": False,
            "reason": "disabled",
            "retrieval_mode": "clinical_guidance",
            "intent": "",
            "refined_query": "",
            "is_followup": bool(payload.get("has_previous_context")),
            "should_refetch": True,
            "attachment": "root",
            "confidence": 0.0,
        }

    provider = os.getenv("LLM_CHAT_PROVIDER", "huggingface").strip().lower()
    if provider == "groq":
        token = os.getenv("GROQ_API_KEY", "").strip()
        if not token:
            return {
                "enabled": False,
                "reason": "missing_groq_api_key",
                "retrieval_mode": "clinical_guidance",
                "intent": "",
                "refined_query": "",
                "is_followup": bool(payload.get("has_previous_context")),
                "should_refetch": True,
                "attachment": "root",
                "confidence": 0.0,
            }
        model = os.getenv("GROQ_REASONING_HEAD_MODEL", os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")).strip()
    else:
        token = os.getenv("HF_TOKEN", "").strip()
        if not token:
            return {
                "enabled": False,
                "reason": "missing_hf_token",
                "retrieval_mode": "clinical_guidance",
                "intent": "",
                "refined_query": "",
                "is_followup": bool(payload.get("has_previous_context")),
                "should_refetch": True,
                "attachment": "root",
                "confidence": 0.0,
            }
        model = os.getenv("HF_REASONING_HEAD_MODEL", os.getenv("HF_SEMANTIC_MODEL", "meta-llama/Llama-3.1-8B-Instruct")).strip()

    system_prompt = (
        "You are a medical retrieval reasoning head. "
        "Return strict JSON only. "
        "Decide intent routing and follow-up behavior for fast evidence retrieval."
    )
    user_prompt = (
        "Given the current message and short conversation context, output JSON keys:\n"
        "- retrieval_mode: clinical_guidance | ongoing_studies | intervention_landscape | research_summary\n"
        "- intent: normalized short intent text\n"
        "- refined_query: best retrieval query preserving disease/topic/location\n"
        "- is_followup: boolean\n"
        "- should_refetch: boolean\n"
        "- attachment: root | previous_turn | new_subintent | out_of_scope\n"
        "- confidence: float 0..1\n"
        "- reason: short explanation\n\n"
        "Rules:\n"
        "- If message is clearly medical and changes topic (e.g. smoking risk), use new_subintent (not out_of_scope).\n"
        "- Use out_of_scope only for clearly non-medical asks.\n"
        "- Prefer refetch=true for new_subintent, refetch=false for simple refinements.\n\n"
        f"Message: {payload.get('message', '')}\n"
        f"Disease: {payload.get('disease', '')}\n"
        f"Location: {payload.get('location', '')}\n"
        f"Root intent: {payload.get('root_intent', '')}\n"
        f"Previous intent: {payload.get('previous_intent', '')}\n"
        f"Conversation summary: {payload.get('conversation_summary', '')}\n"
        f"Has previous context: {bool(payload.get('has_previous_context', False))}\n"
    )

    try:
        parsed = _chat_json(model, system_prompt, user_prompt, max_tokens=240, temperature=0.0)
    except Exception as error:
        return {
            "enabled": False,
            "reason": f"error:{type(error).__name__}",
            "retrieval_mode": "clinical_guidance",
            "intent": "",
            "refined_query": "",
            "is_followup": bool(payload.get("has_previous_context")),
            "should_refetch": True,
            "attachment": "root",
            "confidence": 0.0,
            "provider": provider,
            "model": model,
        }

    retrieval_mode = str(parsed.get("retrieval_mode", "")).strip().lower()
    if retrieval_mode not in {"clinical_guidance", "ongoing_studies", "intervention_landscape", "research_summary"}:
        retrieval_mode = "clinical_guidance"

    attachment = str(parsed.get("attachment", "")).strip().lower()
    if attachment not in {"root", "previous_turn", "new_subintent", "out_of_scope"}:
        attachment = "root"

    confidence_raw = parsed.get("confidence")
    try:
        confidence = float(confidence_raw)
        if confidence < 0 or confidence > 1:
            confidence = 0.0
    except Exception:
        confidence = 0.0

    message = str(payload.get("message", "")).strip().lower()
    if attachment == "out_of_scope" and any(term in message for term in ["cancer", "hiv", "malaria", "smoking", "tobacco", "trial", "treatment", "disease", "infection"]):
        attachment = "new_subintent"

    is_followup = parsed.get("is_followup")
    if not isinstance(is_followup, bool):
        is_followup = bool(payload.get("has_previous_context")) and len(message.split()) <= 10

    should_refetch = parsed.get("should_refetch")
    if not isinstance(should_refetch, bool):
        should_refetch = attachment in {"new_subintent", "root"} or not is_followup

    refined_query = " ".join(str(parsed.get("refined_query", "")).split()).strip()
    intent = " ".join(str(parsed.get("intent", "")).split()).strip()
    if not refined_query:
        refined_query = " ".join(part for part in [
            payload.get("disease", ""),
            intent or payload.get("previous_intent", "") or payload.get("root_intent", ""),
            payload.get("location", ""),
        ] if str(part).strip()).strip()

    return {
        "enabled": True,
        "reason": "ok",
        "retrieval_mode": retrieval_mode,
        "intent": intent,
        "refined_query": refined_query,
        "is_followup": is_followup,
        "should_refetch": should_refetch,
        "attachment": attachment,
        "confidence": confidence,
        "explanation": str(parsed.get("reason", "")).strip(),
        "provider": provider,
        "model": model,
    }
