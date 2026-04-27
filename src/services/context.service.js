function normalizeText(value) {
    return String(value || "").trim().toLowerCase().replace(/[’]/g, "'");
}

const MEDICAL_SIGNALS = [
    "disease", "cancer", "hiv", "malaria", "infection", "treatment", "therapy",
    "clinical", "trial", "prevalence", "incidence", "mortality", "survival",
    "symptom", "diagnosis", "intervention", "guideline", "women", "men", "children", "adults",
    "smoking", "tobacco", "nicotine", "risk factor", "cause", "causality", "outcome", "outcomes",
    "prevention", "prevent", "preventive", "prophylaxis", "screening", "risk reduction", "control measures", "public health",
    "vitamin d", "supplement", "supplementation", "treated", "treat"
];

function hasMedicalSignals(text = "", medicalContext = {}) {
    const normalized = normalizeText(text);
    const disease = normalizeText(medicalContext.disease);
    const intent = normalizeText(medicalContext.intent);
    const location = normalizeText(medicalContext.location);
    const contextText = `${disease} ${intent} ${location}`.trim();
    return MEDICAL_SIGNALS.some((term) => normalized.includes(term) || contextText.includes(term));
}

function parseGreeting(message = "", medicalContext = {}) {
    const normalized = normalizeText(message);
    if (!normalized) {
        return {
            isGreeting: false,
            variant: "",
            hasMedicalContext: false,
            strippedMessage: ""
        };
    }

    const patterns = [
        { variant: "morning", regex: /^good\s+morning\b[\s,!.-]*/i },
        { variant: "afternoon", regex: /^good\s+afternoon\b[\s,!.-]*/i },
        { variant: "evening", regex: /^good\s+evening\b[\s,!.-]*/i },
        { variant: "morning", regex: /^morning\b[\s,!.-]*/i },
        { variant: "afternoon", regex: /^afternoon\b[\s,!.-]*/i },
        { variant: "evening", regex: /^evening\b[\s,!.-]*/i },
        { variant: "generic", regex: /^(hi|hello|hey|yo|sup)\b[\s,!.-]*/i }
    ];

    const matched = patterns.find((item) => item.regex.test(normalized));
    if (!matched) {
        return {
            isGreeting: false,
            variant: "",
            hasMedicalContext: false,
            strippedMessage: ""
        };
    }

    const strippedMessage = normalized.replace(matched.regex, "").trim();
    // Only treat as "greeting + medical context" when there is actual residual text.
    // We intentionally ignore prior session medical context for pure greetings.
    const hasMedicalContext = !!strippedMessage && hasMedicalSignals(strippedMessage, medicalContext);
    return {
        isGreeting: true,
        variant: matched.variant,
        hasMedicalContext,
        strippedMessage
    };
}

function greetingReply(variant = "generic") {
    if (variant === "morning") {
        return "Good morning — I’m ready to help. Share a medical evidence question (disease + population + outcome) and I’ll ground it in sources.";
    }
    if (variant === "afternoon") {
        return "Good afternoon — ready when you are. Ask a medical evidence question (disease + population + outcome), and I’ll ground the answer in sources.";
    }
    if (variant === "evening") {
        return "Good evening — I’m here and ready. Send a medical evidence question (disease + population + outcome), and I’ll ground the response in sources.";
    }
    return "Hi — I’m ready. Ask a medical evidence question (for example: disease + population + outcome), and I’ll ground the answer in sources.";
}

function buildCaseRetrievalQuery(message = "") {
    const raw = String(message || "").trim();
    const text = normalizeText(raw).replace(/[’]/g, "'");
    if (!text) return { enabled: false, query: "", disease: "", reason: "empty" };

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const looksCase = wordCount >= 40 && /(diagnosed|medical history|current disease status|current symptoms|stage|biomarker|molecular|ecog|hoehn|yahr|disease duration|medication history|non-motor symptoms)/.test(text);
    if (!looksCase) {
        return { enabled: false, query: "", disease: "", reason: "not_case_narrative" };
    }

    let disease = "";
    const diagnosedMatch = text.match(/diagnosed(?:\s+in\s+\d{4})?\s+with\s+([a-z0-9\s\-(),']+?)(?:\.|,|\bstage\b|\bafter\b|\bcurrent\b)/i);
    if (diagnosedMatch?.[1]) {
        disease = diagnosedMatch[1].replace(/\s+/g, " ").trim();
    } else {
        const diseaseHint = text.match(/\b(parkinson[’']?s disease|non-small cell lung cancer|nsclc|lung cancer|hiv|malaria|diabetes)\b/i);
        disease = diseaseHint ? String(diseaseHint[1]).trim() : "";
    }

    const stageMatch = text.match(/\bstage\s+([ivx]+[a-c]?|\d+[a-c]?)\b/i);
    const stage = stageMatch ? `stage ${String(stageMatch[1]).toUpperCase()}` : "";

    const biomarkers = [];
    if (/egfr[^.\n]*negative|egfr mutation:\s*negative/.test(text)) biomarkers.push("EGFR negative");
    if (/alk[^.\n]*negative|alk rearrangement:\s*negative/.test(text)) biomarkers.push("ALK negative");
    const pdl1 = text.match(/pd[-\s]?l1[^0-9]*(\d{1,3})\s*%/i);
    if (pdl1?.[1]) biomarkers.push(`PD-L1 ${pdl1[1]}%`);

    const prior = [];
    if (/chemoradiation|carboplatin|paclitaxel|radiation/.test(text)) prior.push("post chemoradiation");
    if (/durvalumab|consolidation immunotherapy/.test(text)) prior.push("post durvalumab");
    if (/levodopa|dopaminergic/.test(text)) prior.push("levodopa wearing off");

    let phase = "";
    if (/surveillance|stable disease|no progression/.test(text)) phase = "surveillance";
    else if (/progression|relapse|wearing-off/.test(text)) phase = "progression";

    const query = [
        disease,
        stage,
        ...biomarkers,
        ...prior,
        phase,
        "relevant research and clinical trials"
    ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    if (!query) {
        return { enabled: false, query: "", disease: "", reason: "no_query_constructed" };
    }
    return {
        enabled: true,
        query,
        disease,
        reason: "case_narrative_rewrite"
    };
}

function defaultSourcePolicy(retrievalMode) {
    return {
        primary: "pubmed",
        supplemental: "clinicaltrials",
        exploratory: "openalex"
    };
}

function normalizeSourcePolicy(policy = {}) {
    return {
        primary: "pubmed",
        supplemental: "clinicaltrials",
        exploratory: "openalex",
        ...policy,
        primary: "pubmed",
        supplemental: "clinicaltrials",
        exploratory: "openalex"
    };
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function detectTerms(text, terms) {
    return terms.filter((term) => text.includes(term));
}

function normalizeLocation(rawLocation = "") {
    const normalized = String(rawLocation || "").trim();
    const tokens = normalized
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1);

    return {
        raw: rawLocation || "",
        normalized,
        tokens: unique(tokens)
    };
}

function inferRetrievalMode(normalizedMessage, intentText) {
    if (/(ongoing|recruiting|active studies|current studies|what is being studied|under investigation)/.test(normalizedMessage)) {
        return "ongoing_studies";
    }
    if (/(intervention|therapy|therapies|tested|being tested|evaluated)/.test(normalizedMessage)) {
        return "intervention_landscape";
    }
    if (/(top research|best research|literature|review|summary|research)/.test(normalizedMessage) || intentText === "research_lookup") {
        return "research_summary";
    }
    return "clinical_guidance";
}

function isGreetingOrSmallTalk(message = "") {
    const parsed = parseGreeting(message, {});
    if (parsed.isGreeting) {
        return !parsed.hasMedicalContext && !parsed.strippedMessage;
    }
    const text = normalizeText(message);
    if (!text) return false;
    const directSmallTalk = /^(how are you|thanks|thank you)$/.test(text);
    const shortSmallTalk = text.split(/\s+/).length <= 3 && /(thanks|thank you)/.test(text);
    return directSmallTalk || shortSmallTalk;
}

function isLikelyMedicalQuery(message = "", medicalContext = {}) {
    const text = normalizeText(message);
    const disease = normalizeText(medicalContext.disease);
    const intent = normalizeText(medicalContext.intent);
    const combined = `${text} ${disease} ${intent}`.trim();
    if (!combined) return false;

    const clearlyNonMedical = /(football|soccer|basketball|music|movie|politics|weather)/.test(text);
    if (clearlyNonMedical) return false;
    const hasTextSignal = MEDICAL_SIGNALS.some((term) => text.includes(term));
    const hasContextSignal = MEDICAL_SIGNALS.some((term) => `${disease} ${intent}`.includes(term));
    if (hasTextSignal) return true;
    if (!text) return hasContextSignal;
    if (text.split(/\s+/).length <= 3 && hasContextSignal) return true;
    if (!hasTextSignal && text.split(/\s+/).length > 3) return false;

    return false;
}

function buildIntent(message, medicalContext = {}, previousMemory = {}) {
    const normalizedMessage = normalizeText(message);
    const followupContext = medicalContext.followupContext || previousMemory.activeCaseFrame?.followupContext || {};
    const disease = normalizeText(
        medicalContext.disease
        || followupContext.resolvedDisease
        || previousMemory.activeCaseFrame?.disease
        || ""
    );
    const resolvedFacets = unique(
        Array.isArray(followupContext.resolvedFacets)
            ? followupContext.resolvedFacets.map((item) => normalizeText(item)).filter(Boolean)
            : []
    );
    const population = normalizeText(followupContext.resolvedPopulation || "");
    const messageConditions = unique([
        disease,
        ...detectTerms(normalizedMessage, ["malaria", "fever", "vomiting", "dehydration"]),
    ]);
    const seedConditions = unique([
        ...messageConditions,
        ...(previousMemory.conditions || [])
    ]);
    const followupIntent = normalizeText(followupContext.intent || followupContext.query || "");
    const intentText = medicalContext.intent || followupIntent || (
        normalizedMessage.includes("trial") || normalizedMessage.includes("study")
            ? "research_lookup"
            : normalizedMessage.includes("can i") || normalizedMessage.includes("should i")
                ? "care_guidance"
                : "clinical_question"
    );
    const substances = unique([
        ...detectTerms(normalizedMessage, ["water", "hydration", "vitamin d", "act", "act therapy"]),
        ...(previousMemory.substances || [])
    ]);
    const symptoms = unique([
        ...detectTerms(normalizedMessage, ["fever", "vomiting", "headache", "chills", "fatigue"]),
        ...(previousMemory.symptoms || [])
    ]);
    const riskFlags = unique([
        normalizedMessage.includes("vomiting") ? "reduced_oral_intake" : null,
        normalizedMessage.includes("unable to drink") || normalizedMessage.includes("cannot drink") ? "unable_to_drink" : null,
        normalizedMessage.includes("worse") || normalizedMessage.includes("worsening") ? "worsening_symptoms" : null,
        ...(previousMemory.riskFlags || [])
    ]);
    const location = normalizeLocation(
        medicalContext.location
        || followupContext.resolvedLocation
        || previousMemory.activeCaseFrame?.location
        || previousMemory.location?.normalized
        || ""
    );
    const retrievalMode = inferRetrievalMode(normalizedMessage, intentText);

    return {
        disease: disease || messageConditions[0] || "",
        intent: intentText,
        retrievalMode,
        sourcePolicy: normalizeSourcePolicy(defaultSourcePolicy(retrievalMode)),
        routeConfidence: 0.35,
        routeReasoning: "Fallback heuristic router used locally.",
        location,
        population,
        resolvedFacets,
        normalizedMessage,
        conditions: seedConditions,
        symptoms,
        substances,
        riskFlags,
        tokens: unique(normalizedMessage.split(/[^a-z0-9]+/).filter((token) => token.length > 2)),
        followupContext: Object.keys(followupContext || {}).length ? followupContext : null
    };
}

module.exports = {
    buildIntent,
    defaultSourcePolicy,
    normalizeSourcePolicy,
    normalizeLocation,
    unique,
    isLikelyMedicalQuery,
    isGreetingOrSmallTalk,
    parseGreeting,
    greetingReply,
    buildCaseRetrievalQuery
};
