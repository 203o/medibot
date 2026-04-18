from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class MedicalContext(BaseModel):
    disease: str = Field(..., min_length=1)
    intent: str = Field(..., min_length=1)
    location: str | None = None


class IngestRequest(BaseModel):
    medical_context: MedicalContext
    max_results: int = Field(default=150, ge=1, le=300)
    sources: list[Literal["pubmed", "clinicaltrials", "openalex"]] = Field(
        default_factory=lambda: ["pubmed", "clinicaltrials", "openalex"]
    )


class IngestResponse(BaseModel):
    run_id: str
    stored_at: str
    query: str
    sources: list[str]
    pubmed_count: int
    clinical_trials_count: int
    openalex_count: int
    output_dir: str
    manifest_path: str


class SemanticSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=120, ge=1, le=300)


class SemanticSearchResponse(BaseModel):
    enabled: bool
    indexed_chunks: int
    error: str | None = None
    results: list[dict]


class RouteIntentRequest(BaseModel):
    message: str = Field(..., min_length=1)
    disease: str | None = None
    intent: str | None = None
    location: str | None = None


class RouteIntentResponse(BaseModel):
    retrieval_mode: Literal[
        "clinical_guidance",
        "ongoing_studies",
        "intervention_landscape",
        "research_summary",
    ]
    confidence: float = Field(..., ge=0.0, le=1.0)
    source_policy: dict[str, str]
    scores: dict[str, float]
    reasoning: str
    decision_source: str = "embedding"
    embedding_mode: str = ""
    llm_refinement: dict = Field(default_factory=dict)


class QueryRefinerRequest(BaseModel):
    message: str = Field(..., min_length=1)
    disease: str = ""
    previous_intent: str = ""
    location: str = ""
    base_query: str = ""


class QueryRefinerResponse(BaseModel):
    enabled: bool
    reason: str = ""
    expanded_query: str = ""
    intent_axis: str = ""
    keywords: list[str] = Field(default_factory=list)
    explanation: str = ""
    provider: str = ""
    model: str = ""


class IntentAttachmentRequest(BaseModel):
    message: str = Field(..., min_length=1)
    root_intent: str = ""
    conversation_summary: str = ""
    last_turn_intent: str = ""
    last_turn_message: str = ""
    disease: str = ""
    location: str = ""


class IntentAttachmentResponse(BaseModel):
    enabled: bool
    reason: str = ""
    attachment: Literal["root", "previous_turn", "new_subintent", "out_of_scope"] = "root"
    intent: str = ""
    query: str = ""
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    explanation: str = ""
    provider: str = ""
    model: str = ""


class ReasoningHeadRequest(BaseModel):
    message: str = Field(..., min_length=1)
    disease: str = ""
    location: str = ""
    root_intent: str = ""
    previous_intent: str = ""
    conversation_summary: str = ""
    has_previous_context: bool = False


class ReasoningHeadResponse(BaseModel):
    enabled: bool
    reason: str = ""
    retrieval_mode: Literal[
        "clinical_guidance",
        "ongoing_studies",
        "intervention_landscape",
        "research_summary",
    ] = "clinical_guidance"
    intent: str = ""
    refined_query: str = ""
    is_followup: bool = False
    should_refetch: bool = True
    attachment: Literal["root", "previous_turn", "new_subintent", "out_of_scope"] = "root"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    explanation: str = ""
    provider: str = ""
    model: str = ""


class SemanticJudgeDocument(BaseModel):
    id: str
    source: str
    title: str = ""
    snippet: str = ""
    study_type: str = ""
    year: int | None = None


class SemanticJudgeRequest(BaseModel):
    query: str = Field(..., min_length=1)
    disease: str = ""
    intent: str = ""
    retrieval_mode: str = ""
    documents: list[SemanticJudgeDocument] = Field(default_factory=list)


class SemanticJudgeResult(BaseModel):
    id: str
    relevant: bool | None = None
    reason: str = ""
    tier_suggestion: int | None = Field(default=None, ge=1, le=4)
    doc_type: str = ""
    focus: str = ""
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class SemanticJudgeResponse(BaseModel):
    enabled: bool
    reason: str = ""
    results: list[SemanticJudgeResult] = Field(default_factory=list)


class TieredSynthesisRequest(BaseModel):
    query: str = Field(..., min_length=1)
    disease: str = ""
    intent: str = ""
    retrieval_mode: str = ""
    primary_evidence: list[dict] = Field(default_factory=list)
    supplemental_evidence: list[dict] = Field(default_factory=list)
    citation_catalog: dict = Field(default_factory=dict)
    conflict_hints: list[str] = Field(default_factory=list)
    conflict_level: Literal["none", "mild", "strong"] = "none"
    tone_mode: Literal["clinical", "conversational", "concise"] = "clinical"
    research_mode: bool = False
    research_focus: list[str] = Field(default_factory=list)
    case_anchors: dict = Field(default_factory=dict)


class TieredSynthesisResponse(BaseModel):
    enabled: bool
    reason: str = ""
    direct_answer: str = ""
    supporting_explanation: str = ""
    evidence_points: list[str] = Field(default_factory=list)
    study_spotlight: dict = Field(default_factory=dict)
    uncertainties: list[str] = Field(default_factory=list)
    claims: list[dict] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)
    answer: str = ""
    research_landscape: list[str] = Field(default_factory=list)
    relevant_trials: list[str] = Field(default_factory=list)
    progression_research: list[str] = Field(default_factory=list)
    monitoring_research: list[str] = Field(default_factory=list)
    evidence_gaps: list[str] = Field(default_factory=list)
    evidence_mixed: bool = False
    conflict_reason: str = ""
    conflict_details: list[str] = Field(default_factory=list)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
