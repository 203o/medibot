from __future__ import annotations

from pathlib import Path
import os

from fastapi import FastAPI
from dotenv import load_dotenv

from ingestion_api.schemas import (
    IngestRequest,
    IngestResponse,
    RouteIntentRequest,
    RouteIntentResponse,
    SemanticJudgeRequest,
    SemanticJudgeResponse,
    QueryRefinerRequest,
    QueryRefinerResponse,
    IntentAttachmentRequest,
    IntentAttachmentResponse,
    ReasoningHeadRequest,
    ReasoningHeadResponse,
    TieredSynthesisRequest,
    TieredSynthesisResponse,
    SemanticSearchRequest,
    SemanticSearchResponse,
)
from ingestion_api.services.faiss_store import FaissStore
from ingestion_api.services.ingestion import ingest_sources
from ingestion_api.services.intent_router import route_intent
from ingestion_api.services.semantic_llm import (
    classify_documents,
    synthesize_tiered,
    refine_intent,
    infer_medical_context,
    expand_followup_query,
    classify_intent_attachment,
    reasoning_head,
)
from ingestion_api.services.semantic_retrieval import semantic_index_and_search


APP_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(APP_ROOT / ".env", override=True)
DATA_DIR = APP_ROOT / "data" / "raw"
PUBMED_TOOL = os.getenv("PUBMED_TOOL", "medibot-fastapi-ingestion")
PUBMED_EMAIL = os.getenv("PUBMED_EMAIL", "example@example.com")

app = FastAPI(title="MediBot Ingestion API", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str | bool]:
    faiss_store = FaissStore()
    return {
        "status": "ok",
        "service": "medibot-fastapi-ingestion",
        "faiss_enabled": faiss_store.is_enabled(),
    }


@app.get("/api/health")
def api_health() -> dict[str, str]:
    return health()


@app.post("/ingest", response_model=IngestResponse)
def ingest(payload: IngestRequest) -> IngestResponse:
    result = ingest_sources(
        payload=payload,
        base_data_dir=DATA_DIR,
        pubmed_tool=PUBMED_TOOL,
        pubmed_email=PUBMED_EMAIL,
    )
    return IngestResponse(**result)


@app.post("/api/ingest", response_model=IngestResponse)
def api_ingest(payload: IngestRequest) -> IngestResponse:
    return ingest(payload)


@app.post("/semantic-search", response_model=SemanticSearchResponse)
def semantic_search(payload: SemanticSearchRequest) -> SemanticSearchResponse:
    result = semantic_index_and_search(
        query=payload.query,
        pubmed_records=[],
        clinical_trials_records=[],
        openalex_records=[],
        top_k=payload.top_k,
    )
    return SemanticSearchResponse(
        enabled=result["enabled"],
        indexed_chunks=result["indexed_chunks"],
        error=result.get("error"),
        results=result["grouped_hits"],
    )


@app.post("/api/semantic-search", response_model=SemanticSearchResponse)
def api_semantic_search(payload: SemanticSearchRequest) -> SemanticSearchResponse:
    return semantic_search(payload)


@app.post("/route-intent", response_model=RouteIntentResponse)
def route_intent_endpoint(payload: RouteIntentRequest) -> RouteIntentResponse:
    result = route_intent(
        message=payload.message,
        disease=payload.disease or "",
        intent=payload.intent or "",
        location=payload.location or "",
    )
    return RouteIntentResponse(**result)


@app.post("/api/route-intent", response_model=RouteIntentResponse)
def api_route_intent(payload: RouteIntentRequest) -> RouteIntentResponse:
    return route_intent_endpoint(payload)


@app.post("/refine-intent", response_model=dict)
def refine_intent_endpoint(payload: RouteIntentRequest) -> dict:
    return refine_intent(payload.model_dump())


@app.post("/api/refine-intent", response_model=dict)
def api_refine_intent(payload: RouteIntentRequest) -> dict:
    return refine_intent_endpoint(payload)


@app.post("/infer-medical-context", response_model=dict)
def infer_medical_context_endpoint(payload: RouteIntentRequest) -> dict:
    return infer_medical_context(payload.model_dump())


@app.post("/api/infer-medical-context", response_model=dict)
def api_infer_medical_context(payload: RouteIntentRequest) -> dict:
    return infer_medical_context_endpoint(payload)


@app.post("/expand-followup-query", response_model=QueryRefinerResponse)
def expand_followup_query_endpoint(payload: QueryRefinerRequest) -> QueryRefinerResponse:
    result = expand_followup_query(payload.model_dump())
    return QueryRefinerResponse(**result)


@app.post("/api/expand-followup-query", response_model=QueryRefinerResponse)
def api_expand_followup_query(payload: QueryRefinerRequest) -> QueryRefinerResponse:
    return expand_followup_query_endpoint(payload)


@app.post("/classify-intent-attachment", response_model=IntentAttachmentResponse)
def classify_intent_attachment_endpoint(payload: IntentAttachmentRequest) -> IntentAttachmentResponse:
    result = classify_intent_attachment(payload.model_dump())
    return IntentAttachmentResponse(**result)


@app.post("/api/classify-intent-attachment", response_model=IntentAttachmentResponse)
def api_classify_intent_attachment(payload: IntentAttachmentRequest) -> IntentAttachmentResponse:
    return classify_intent_attachment_endpoint(payload)


@app.post("/reasoning-head", response_model=ReasoningHeadResponse)
def reasoning_head_endpoint(payload: ReasoningHeadRequest) -> ReasoningHeadResponse:
    result = reasoning_head(payload.model_dump())
    return ReasoningHeadResponse(**result)


@app.post("/api/reasoning-head", response_model=ReasoningHeadResponse)
def api_reasoning_head(payload: ReasoningHeadRequest) -> ReasoningHeadResponse:
    return reasoning_head_endpoint(payload)


@app.post("/semantic-judge", response_model=SemanticJudgeResponse)
def semantic_judge(payload: SemanticJudgeRequest) -> SemanticJudgeResponse:
    result = classify_documents(payload.model_dump())
    return SemanticJudgeResponse(**result)


@app.post("/api/semantic-judge", response_model=SemanticJudgeResponse)
def api_semantic_judge(payload: SemanticJudgeRequest) -> SemanticJudgeResponse:
    return semantic_judge(payload)


@app.post("/synthesize-tiered", response_model=TieredSynthesisResponse)
def synthesize_tiered_endpoint(payload: TieredSynthesisRequest) -> TieredSynthesisResponse:
    result = synthesize_tiered(payload.model_dump())
    return TieredSynthesisResponse(**result)


@app.post("/api/synthesize-tiered", response_model=TieredSynthesisResponse)
def api_synthesize_tiered(payload: TieredSynthesisRequest) -> TieredSynthesisResponse:
    return synthesize_tiered_endpoint(payload)
