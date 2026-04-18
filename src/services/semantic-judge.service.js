function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

function toJudgePayload(item) {
    return {
        id: item.id,
        source: item.source,
        title: item.title || "",
        snippet: item.snippet || "",
        study_type: item.studyType || "",
        year: item.year || null
    };
}

async function enrichEvidenceWithSemanticJudge(evidence, intent, message) {
    const enabled = String(process.env.ENABLE_LLM_SEMANTIC_CLASSIFIER || "false").toLowerCase() === "true";
    if (!enabled || !Array.isArray(evidence) || evidence.length === 0) {
        return evidence;
    }

    const maxDocs = Number(process.env.LLM_CLASSIFY_MAX_DOCS || 8);
    const docsForJudge = evidence.slice(0, maxDocs).map(toJudgePayload);

    try {
        const response = await fetch(`${getIngestionBaseUrl()}/semantic-judge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: message || intent.normalizedMessage || intent.intent || "",
                disease: intent.disease || "",
                intent: intent.intent || "",
                retrieval_mode: intent.retrievalMode || "",
                documents: docsForJudge
            })
        });

        if (!response.ok) {
            throw new Error(`semantic-judge failed with status ${response.status}`);
        }
        const payload = await response.json();
        const byId = new Map((payload.results || []).map((item) => [item.id, item]));
        return evidence.map((item) => ({
            ...item,
            llmSemantic: byId.get(item.id) || null
        }));
    } catch (error) {
        console.warn("Semantic judge unavailable:", error.message);
        return evidence;
    }
}

module.exports = {
    enrichEvidenceWithSemanticJudge
};
