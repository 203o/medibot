const { defaultSourcePolicy, normalizeSourcePolicy } = require("./context.service");

function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

async function routeIntent(message, intent) {
    try {
        const response = await fetch(`${getIngestionBaseUrl()}/route-intent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message,
                disease: intent.disease || "",
                intent: intent.intent || "",
                location: intent.location?.normalized || ""
            })
        });

        if (!response.ok) {
            throw new Error(`Intent routing failed with status ${response.status}`);
        }

        const payload = await response.json();
        const routedMode = payload.retrieval_mode;
        const normalizedMessage = String(message || "").toLowerCase();
        const looksLikeTreatmentQuestion = /(treatment|treat|therapy|therapies|management|first line|second line|drug)/.test(normalizedMessage);
        const looksLikeLatestEvidence = /(latest|new|recent|current)/.test(normalizedMessage);
        const looksLikeStudyTracking = /(ongoing|recruiting|active studies|what is being studied|under investigation)/.test(normalizedMessage);
        const patchedMode = (routedMode === "ongoing_studies" && looksLikeTreatmentQuestion && looksLikeLatestEvidence && !looksLikeStudyTracking)
            ? "intervention_landscape"
            : routedMode;

        return {
            retrievalMode: patchedMode,
            routeConfidence: Number(payload.confidence || 0),
            routeReasoning: patchedMode !== routedMode
                ? `${payload.reasoning || ""} Patched retrieval mode to intervention_landscape for latest-treatment query.`
                : (payload.reasoning || ""),
            routeScores: payload.scores || {},
            routeDecisionSource: payload.decision_source || "embedding",
            routeEmbeddingMode: payload.embedding_mode || routedMode || "",
            routeLlmRefinement: payload.llm_refinement || {},
            sourcePolicy: normalizeSourcePolicy(payload.source_policy || defaultSourcePolicy(patchedMode))
        };
    } catch (error) {
        return {
            retrievalMode: intent.retrievalMode || "clinical_guidance",
            routeConfidence: intent.routeConfidence || 0.35,
            routeReasoning: `Fallback heuristic router used locally. ${error.message}`,
            routeScores: {},
            routeDecisionSource: "fallback",
            routeEmbeddingMode: "",
            routeLlmRefinement: {},
            sourcePolicy: normalizeSourcePolicy(intent.sourcePolicy || defaultSourcePolicy(intent.retrievalMode || "clinical_guidance"))
        };
    }
}

module.exports = {
    routeIntent
};
