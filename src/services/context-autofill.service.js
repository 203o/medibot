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

const COMMON_LOCATIONS = [
    "usa", "united states", "canada", "uk", "united kingdom", "kenya", "south africa", "nigeria",
    "india", "china", "boston", "chicago", "turkana", "thika"
];

const FOLLOWUP_FILLER_TOKENS = new Set([
    "what", "about", "how", "in", "for", "and", "of", "the", "to", "on", "at", "is", "are",
    "please", "tell", "me"
]);

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
    const found = COMMON_LOCATIONS.find((item) => text.includes(item));
    return found || "";
}

function tokenize(value = "") {
    return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function isLocationOnlyFollowup(message = "", previousMemory = {}) {
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    if (!previousDisease) return false;

    const text = normalizeText(message);
    if (!text) return false;
    if (heuristicDisease(text)) return false;

    const location = heuristicLocation(text);
    if (!location) return false;

    const locationTokens = tokenize(location);
    const meaningfulTokens = tokenize(text).filter((token) => {
        if (FOLLOWUP_FILLER_TOKENS.has(token)) return false;
        return !locationTokens.includes(token);
    });

    return meaningfulTokens.length === 0;
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
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    const locationOnlyFollowup = isLocationOnlyFollowup(message, previousMemory);

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

    if (locationOnlyFollowup && previousDisease) {
        disease = previousDisease;
        if (autofillSource === "user") {
            autofillSource = "heuristic";
        }
        confidence = Math.max(confidence, 0.8);
        reason = reason ? `${reason}|preserve_previous_disease_for_location_followup` : "preserve_previous_disease_for_location_followup";
    }

    if (!disease) {
        disease = fallbackTopicDisease(message);
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
