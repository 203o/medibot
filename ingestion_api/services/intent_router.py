from __future__ import annotations

from functools import lru_cache

from ingestion_api.services.embeddings import embed_texts
from ingestion_api.services.semantic_llm import refine_intent


MODE_PROTOTYPES = {
    "clinical_guidance": [
        "The user wants practical clinical guidance grounded in published medical evidence for a current care question.",
        "The user is asking what they should do, what is safe, or how to manage symptoms or supportive care.",
        "Can I drink water during malaria treatment and what care guidance is supported by evidence?",
        "What should I do for symptom management and supportive care right now?",
    ],
    "ongoing_studies": [
        "The user wants current, active, recruiting, or ongoing registered studies and trials on a disease or intervention.",
        "The user is asking what is being studied now, which trials are active, or what investigations are underway.",
        "What ongoing studies are there for malaria in Kenya right now?",
        "Are there any active or recruiting trials investigating hydration support for malaria?",
    ],
    "intervention_landscape": [
        "The user wants therapies, interventions, or treatment approaches being tested or evaluated across studies.",
        "The user is asking about intervention options under investigation rather than bedside guidance.",
        "What interventions are being tested for malaria treatment or supportive care?",
        "Which therapies are under investigation for this condition?",
    ],
    "research_summary": [
        "The user wants a research overview, strongest evidence summary, or top published studies on a topic.",
        "The user is asking for the best research, key publications, reviews, or literature summary.",
        "What does the top published research say about hydration and malaria?",
        "Give me a literature summary and best studies on this topic.",
    ],
}

SOURCE_POLICY = {
    "clinical_guidance": {"primary": "pubmed", "supplemental": "clinicaltrials"},
    "ongoing_studies": {"primary": "clinicaltrials", "supplemental": "pubmed"},
    "intervention_landscape": {"primary": "clinicaltrials", "supplemental": "pubmed"},
    "research_summary": {"primary": "pubmed", "supplemental": "clinicaltrials"},
}

INTENT_TO_MODE = {
    "clinical_guidance": "clinical_guidance",
    "ongoing_studies": "ongoing_studies",
    "intervention_landscape": "intervention_landscape",
    "research_summary": "research_summary",
    "risk_factor": "research_summary",
    "causality": "research_summary",
    "general_knowledge": "research_summary",
}


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    return max(0.0, min(1.0, sum(a * b for a, b in zip(left, right))))


@lru_cache(maxsize=1)
def _prototype_embeddings() -> dict[str, list[list[float]]]:
    return {
        mode: embed_texts(texts)
        for mode, texts in MODE_PROTOTYPES.items()
    }


def route_intent(message: str, disease: str = "", intent: str = "", location: str = "") -> dict:
    query_text = " ".join(part for part in [
        message.strip(),
        disease.strip(),
        intent.strip(),
        location.strip(),
    ] if part).strip()
    query_embedding = embed_texts([query_text])[0]

    scores: dict[str, float] = {}
    prototypes = _prototype_embeddings()
    for mode, embeddings in prototypes.items():
        similarities = [_cosine_similarity(query_embedding, embedding) for embedding in embeddings]
        scores[mode] = round(max(similarities), 4)

    sorted_modes = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    selected_mode, selected_score = sorted_modes[0]
    runner_up_score = sorted_modes[1][1] if len(sorted_modes) > 1 else 0.0
    confidence = max(0.0, min(1.0, round(selected_score - runner_up_score + 0.55, 3)))

    reasoning = (
        f"Selected {selected_mode} because its prototype embedding was closest to the user turn. "
        f"Top score={selected_score:.3f}, runner-up={runner_up_score:.3f}."
    )

    llm_refinement = {"enabled": False, "reason": "not_needed"}
    decision_source = "embedding"
    final_mode = selected_mode

    needs_refinement = confidence < 0.7 or len(query_text.split()) <= 6
    if needs_refinement:
        llm_refinement = refine_intent(
            {
                "message": message,
                "disease": disease,
                "intent": intent,
                "location": location,
            }
        )
        if llm_refinement.get("enabled"):
            llm_intent = llm_refinement.get("intent_type", "research_summary")
            llm_mode = INTENT_TO_MODE.get(llm_intent, "research_summary")
            llm_conf = float(llm_refinement.get("confidence", 0.0) or 0.0)
            if confidence < 0.7 and llm_conf >= 0.45:
                final_mode = llm_mode
                decision_source = "llm_refinement"
                reasoning = (
                    f"{reasoning} Low embedding confidence triggered LLM refinement. "
                    f"LLM intent={llm_intent}, mode={llm_mode}, llm_confidence={llm_conf:.3f}."
                )
            elif llm_refinement.get("is_medical") is False:
                final_mode = "research_summary"
                decision_source = "llm_refinement_non_medical"
                reasoning = (
                    f"{reasoning} LLM flagged query as likely non-medical; kept safe fallback mode research_summary."
                )
            else:
                reasoning = (
                    f"{reasoning} LLM refinement checked but embedding route retained. "
                    f"LLM intent={llm_intent}, llm_confidence={llm_conf:.3f}."
                )
        else:
            reasoning = f"{reasoning} LLM refinement unavailable ({llm_refinement.get('reason', 'unknown')})."

    return {
        "retrieval_mode": final_mode,
        "confidence": confidence,
        "source_policy": SOURCE_POLICY[final_mode],
        "scores": scores,
        "reasoning": reasoning,
        "decision_source": decision_source,
        "embedding_mode": selected_mode,
        "llm_refinement": llm_refinement,
    }
