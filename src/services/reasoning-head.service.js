function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

function summarizeConversation(previousMemory = {}, turns = []) {
    const parts = [];
    if (previousMemory.lastAnswerSummary) {
        parts.push(`Last answer: ${String(previousMemory.lastAnswerSummary).slice(0, 220)}`);
    }
    const lastUser = (turns || []).filter((turn) => turn.role === "user").slice(-1)[0];
    if (lastUser?.message) {
        parts.push(`Last user: ${String(lastUser.message).slice(0, 120)}`);
    }
    if (previousMemory.lastQueryFacets?.disease || previousMemory.lastQueryFacets?.location) {
        parts.push(`Facets disease=${previousMemory.lastQueryFacets?.disease || ""}, location=${previousMemory.lastQueryFacets?.location || ""}`);
    }
    return parts.join(" | ").trim();
}

function hasPriorContext(previousMemory = {}, turns = []) {
    return !!(
        String(previousMemory.lastAnswerSummary || "").trim()
        || (previousMemory.lastRetrievedIds || []).length
        || (turns || []).some((turn) => turn.role === "assistant")
    );
}

async function runReasoningHead({ message, intent, previousMemory = {}, turns = [] }) {
    const enabled = String(process.env.ENABLE_UNIFIED_REASONING_HEAD || "true").toLowerCase() === "true";
    if (!enabled) {
        return {
            enabled: false,
            reason: "disabled"
        };
    }

    const lastUser = (turns || []).filter((turn) => turn.role === "user").slice(-1)[0];
    const payload = {
        message: message || "",
        disease: intent?.disease || previousMemory.lastQueryFacets?.disease || "",
        location: intent?.location?.normalized || previousMemory.lastQueryFacets?.location || "",
        root_intent: previousMemory.intents?.[0] || intent?.intent || "",
        previous_intent: String(lastUser?.intent?.intent || previousMemory.intents?.slice(-1)[0] || intent?.intent || ""),
        conversation_summary: summarizeConversation(previousMemory, turns),
        has_previous_context: hasPriorContext(previousMemory, turns)
    };

    try {
        const response = await fetch(`${getIngestionBaseUrl()}/reasoning-head`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error(`reasoning-head failed with status ${response.status}`);
        }
        return response.json();
    } catch (error) {
        return {
            enabled: false,
            reason: `error:${error.message}`
        };
    }
}

module.exports = {
    runReasoningHead
};

