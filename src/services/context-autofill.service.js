function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

const TOKEN_STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with",
    "what", "which", "how", "does", "do", "is", "are", "can", "could", "should", "would",
    "latest", "new", "current", "about", "question", "patient", "case", "please", "give", "tell",
    "treatment", "therapy", "trial", "trials", "research", "rate", "prevalence", "incidence"
]);

function normalizeText(value = "") {
    return String(value || "").trim();
}

const COMMON_LOCATION_LIKE_TERMS = [
    "usa", "united states", "canada", "uk", "united kingdom", "kenya", "south africa", "nigeria",
    "india", "china", "boston", "chicago", "turkana", "thika", "asia", "africa", "europe",
    "america", "americas", "latin america", "oceania", "australia", "new zealand", "middle east"
];

const FOLLOWUP_PREFIX_REGEX = /^(what about|how about|and |what of|in |for |how does|how do|does it|do they|does that|is there|recheck|rechek|explain|elaborate)\b/;

function heuristicDisease(message = "") {
    const text = String(message || "").toLowerCase().replace(/[’]/g, "'");
    const matches = [
        "non-small cell lung cancer",
        "lung cancer",
        "parkinson's disease",
        "parkinsons disease",
        "parkinson disease",
        "hiv",
        "malaria",
        "diabetes",
        "prostate cancer",
        "breast cancer",
        "colorectal cancer"
    ].find((item) => text.includes(item));
    if (matches) {
        return matches === "parkinsons disease" ? "parkinson's disease" : matches;
    }
    return "";
}

function heuristicLocation(message = "") {
    const text = String(message || "").toLowerCase();
    const found = COMMON_LOCATION_LIKE_TERMS.find((item) => text.includes(item));
    return found || "";
}

function isLocationLikeLabel(value = "") {
    const text = String(value || "").toLowerCase().trim();
    if (!text) return false;
    return COMMON_LOCATION_LIKE_TERMS.some((item) => text === item || text.includes(item));
}

function isFollowupLikeMessage(message = "") {
    const text = normalizeText(message).toLowerCase();
    if (!text) return false;
    return FOLLOWUP_PREFIX_REGEX.test(text) || text.split(/\s+/).filter(Boolean).length <= 6;
}

function getDiseaseAnchor(previousMemory = {}) {
    const candidates = [
        previousMemory?.rootCaseFrame?.disease,
        previousMemory?.lastQueryFacets?.disease
    ];
    if (Array.isArray(previousMemory?.conditions)) {
        candidates.push(...[...previousMemory.conditions].reverse());
    }
    for (const candidate of candidates) {
        const text = normalizeText(candidate);
        if (!text) continue;
        if (heuristicLocation(text) || isLocationLikeLabel(text)) continue;
        if (heuristicDisease(text)) return heuristicDisease(text);
        if (!isGenericDiseaseLabel(text)) return text;
    }
    return "";
}

function fallbackTopicDisease(message = "") {
    const tokens = String(message || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !TOKEN_STOPWORDS.has(token));
    const unique = [...new Set(tokens)].slice(0, 3);
    return unique.join(" ").trim();
}

function isGenericDiseaseLabel(value = "") {
    const text = String(value || "").toLowerCase().trim();
    if (!text) return true;
    if (heuristicLocation(text) || isLocationLikeLabel(text)) return true;
    const knownDiseaseSignals = [
        "cancer", "hiv", "malaria", "diabetes", "parkinson", "tuberculosis", "asthma", "stroke",
        "infection", "nsclc", "carcinoma", "tumor", "tumour"
    ];
    if (knownDiseaseSignals.some((item) => text.includes(item))) return false;
    const genericSignals = [
        "preventive measures", "treatment options", "clinical question", "medical question", "research", "therapy", "outcomes"
    ];
    return genericSignals.includes(text);
}

async function inferMedicalContextWithLLM({ message = "", disease = "", intent = "", location = "" }) {
    try {
        const response = await fetch(`${getIngestionBaseUrl()}/infer-medical-context`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, disease, intent, location })
        });
        if (!response.ok) {
            throw new Error(`infer-medical-context failed with status ${response.status}`);
        }
        const payload = await response.json();
        return {
            enabled: !!payload?.enabled,
            reason: String(payload?.reason || ""),
            disease: normalizeText(payload?.disease),
            location: normalizeText(payload?.location),
            confidence: Number(payload?.confidence || 0),
            provider: String(payload?.provider || ""),
            model: String(payload?.model || ""),
            usedLlm: !!payload?.used_llm
        };
    } catch (error) {
        return {
            enabled: false,
            reason: `error:${error.message}`,
            disease: normalizeText(disease),
            location: normalizeText(location),
            confidence: 0,
            provider: "",
            model: "",
            usedLlm: false
        };
    }
}

async function autofillMedicalContext({ message = "", medicalContext = {}, previousMemory = {} }) {
    const initialDisease = normalizeText(medicalContext?.disease);
    const initialLocation = normalizeText(medicalContext?.location);
    const intent = normalizeText(medicalContext?.intent) || normalizeText(previousMemory?.lastQueryFacets?.retrievalMode);
    const diseaseAnchor = getDiseaseAnchor(previousMemory);
    const followupLike = isFollowupLikeMessage(message);

    let disease = initialDisease || heuristicDisease(message);
    let location = initialLocation || heuristicLocation(message);
    let autofillSource = "user";
    let confidence = 1;
    let provider = "";
    let model = "";
    let reason = "";

    if (!initialDisease && disease) {
        autofillSource = "heuristic";
        confidence = 0.65;
        reason = "heuristic_disease";
    }
    if (!initialLocation && location) {
        autofillSource = autofillSource === "user" ? "heuristic" : autofillSource;
        confidence = Math.max(confidence, 0.65);
        reason = reason ? `${reason}|heuristic_location` : "heuristic_location";
    }

    if (disease && isGenericDiseaseLabel(disease)) {
        disease = "";
    }

    if (!disease && diseaseAnchor && (followupLike || location || initialLocation || initialDisease || previousMemory?.lastAnswerSummary)) {
        disease = diseaseAnchor;
        autofillSource = autofillSource === "user" ? "heuristic" : autofillSource;
        confidence = Math.max(confidence, 0.75);
        reason = reason ? `${reason}|root_disease_preserved` : "root_disease_preserved";
    }

    const needsLlm = !disease || !location;
    if (needsLlm) {
        const llm = await inferMedicalContextWithLLM({
            message,
            disease,
            intent,
            location
        });
        if (llm.enabled) {
            if (!disease && llm.disease) disease = llm.disease;
            if (!location && llm.location) location = llm.location;
            if (llm.usedLlm) {
                autofillSource = "llm";
                confidence = llm.confidence || confidence;
                provider = llm.provider;
                model = llm.model;
                reason = llm.reason || reason;
            }
        }
    }

    if (!disease) {
        if (!diseaseAnchor) {
            disease = fallbackTopicDisease(message);
        }
        if (disease) {
            autofillSource = autofillSource === "user" ? "heuristic" : autofillSource;
            confidence = Math.max(confidence, 0.4);
            reason = reason ? `${reason}|topic_fallback` : "topic_fallback";
        }
    }

    const needsClarification = !disease || isGenericDiseaseLabel(disease);
    return {
        medicalContext: {
            ...medicalContext,
            disease: disease || "",
            location: location || ""
        },
        meta: {
            autofillSource,
            confidence: Number(confidence || 0),
            reason,
            provider,
            model,
            needsClarification
        }
    };
}

module.exports = {
    autofillMedicalContext
};
