from __future__ import annotations

from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json

from ingestion_api.services.evidence_extraction import extract_evidence_sentences


BASE_URL = "https://clinicaltrials.gov/api/v2/studies"


def _get_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "medibot-fastapi-ingestion"})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def search_clinical_trials(queries: list[str], keywords: list[str], location: str | None, max_results: int) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    studies: list[dict[str, Any]] = []
    selected_query = ""
    attempted_queries: list[dict[str, Any]] = []

    for query in queries:
        if not query.strip():
            continue
        for location_filter in ([location, None] if location else [None]):
            params = {
                "query.term": query,
                "pageSize": str(max_results),
                "format": "json",
            }
            if location_filter:
                params["query.locn"] = location_filter

            url = f"{BASE_URL}?{urlencode(params)}"
            payload = _get_json(url)
            studies = payload.get("studies", [])
            attempted_queries.append(
                {
                    "query": query,
                    "location_filter": location_filter or "",
                    "count": len(studies),
                }
            )
            if studies:
                selected_query = query
                break
        if studies:
            break

    normalized: list[dict[str, Any]] = []
    for study in studies:
        identification = study.get("protocolSection", {}).get("identificationModule", {})
        description = study.get("protocolSection", {}).get("descriptionModule", {})
        status = study.get("protocolSection", {}).get("statusModule", {})
        design = study.get("protocolSection", {}).get("designModule", {})

        normalized.append(
            {
                "nct_id": identification.get("nctId", ""),
                "title": identification.get("briefTitle") or identification.get("officialTitle", ""),
                "brief_summary": description.get("briefSummary", ""),
                "detailed_description": description.get("detailedDescription", ""),
                "evidence_sentences": extract_evidence_sentences(
                    "\n\n".join(
                        part for part in [
                            description.get("briefSummary", ""),
                            description.get("detailedDescription", "")
                        ] if part
                    ),
                    keywords
                ),
                "study_type": design.get("studyType", ""),
                "phases": design.get("phases", []),
                "status": status.get("overallStatus", ""),
                "last_update": status.get("lastUpdateSubmitDate", ""),
                "query_keywords": keywords,
                "source_url": f"https://clinicaltrials.gov/study/{identification.get('nctId', '')}" if identification.get("nctId") else "",
                "raw": study,
            }
        )

    return {
        "query": queries[0] if queries else "",
        "selected_query": selected_query,
        "attempted_queries": attempted_queries,
        "location": location or "",
        "records": normalized,
        "payload": payload,
    }
