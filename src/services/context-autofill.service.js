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
    "india", "china", "asia", "africa", "europe", "oceania", "australia", "north america",
    "south america", "latin america", "middle east", "global", "worldwide", "sub-saharan africa",
    "boston", "chicago", "turkana", "thika"
];

const FOLLOWUP_CUE_REGEX = /^(what about|how about|and |what of|in |for |how does|how do|does it|do they|does that|is there|recheck|rechek|explain|elaborate)\b/;

const POPULATION_CUES = [
    "women",
    "woman",
    "men",
    "man",
    "female",
    "male",
    "children",
    "child",
    "adult",
    "adults",
    "elderly",
    "older adults",
    "pregnant",
    "patients",
    "people",
    "survivors"
];

const EXPOSURE_CUES = [
    "football",
    "head injury",
    "head injuries",
    "head impacts",
    "concussion",
    "concussions",
    "trauma",
    "smoking",
    "tobacco",
    "nicotine",
    "cigarette",
    "cigarettes",
    "vaping",
    "alcohol",
    "pesticide",
    "pesticides",
    "pollution",
    "air pollution",
    "asbestos",
    "radiation",
    "occupational",
    "workplace"
];

const ANIMAL_MODEL_CUES = [
    "animal",
    "animals",
    "animal model",
    "animal models",
    "mouse",
    "mice",
    "rat",
    "rats",
    "rodent",
    "rodents",
    "murine",
    "preclinical",
    "in vivo"
];

const MECHANISM_CUES = [
    "mechanism",
    "mechanisms",
    "mechanistic",
    "pathophysiology",
    "pathogenesis",
    "biomarker",
    "biomarkers",
    "molecular",
    "signaling",
    "genetic",
    "genetics",
    "gene",
    "genes",
    "pathway",
    "pathways"
];

const BROAD_DISEASE_LABELS = new Set([
    "cancer",
    "disease",
    "infection",
    "condition",
    "syndrome",
    "disorder",
    "malignancy",
    "tumor",
    "tumour",
    "illness"
]);

const FOLLOWUP_REFINE_RELATIONS = new Set([
    "same_topic",
    "location_refinement",
    "population_refinement",
    "exposure_refinement",
    "animal_model",
    "mechanism_refinement",
    "new_disease",
    "clarify",
    "out_of_scope"
]);

const FOLLOWUP_FILLER_TOKENS = new Set([
    "what", "about", "how", "in", "for", "and", "of", "the", "to", "on", "at", "is", "are",
    "please", "tell", "me"
]);

function heuristicDisease(message = "") {
    const text = String(message || "").toLowerCase().replace(/[’]/g, "'");
    const matches = [
        "non-small cell lung cancer",
        "lung cancer",
        "cancer",
        "parkinson's disease",
        "parkinsons disease",
        "parkinson disease",
        "hiv",
        "malaria",
        "diabetes",
        "infection",
        "prostate cancer",
        "breast cancer",
        "colorectal cancer",
        "carcinoma",
        "malignancy",
        "tumor",
        "tumour",
        "syndrome",
        "disorder",
        "illness",
        "condition"
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

function hasPopulationCue(message = "") {
    const text = String(message || "").toLowerCase();
    return POPULATION_CUES.some((item) => text.includes(item));
}

function containsTerm(text, term) {
    const normalizedText = normalizeText(text).toLowerCase();
    const normalizedTerm = normalizeText(term).toLowerCase();
    if (!normalizedText || !normalizedTerm) return false;
    if (normalizedTerm.includes(" ")) {
        return normalizedText.includes(normalizedTerm);
    }
    return tokenize(normalizedText).includes(normalizedTerm);
}

function matchTerms(message = "", terms = []) {
    return unique(terms.filter((term) => containsTerm(message, term)));
}

function hasExposureCue(message = "") {
    return matchTerms(message, EXPOSURE_CUES).length > 0;
}

function hasAnimalModelCue(message = "") {
    return matchTerms(message, ANIMAL_MODEL_CUES).length > 0;
}

function hasMechanismCue(message = "") {
    return matchTerms(message, MECHANISM_CUES).length > 0;
}

function hasSupportedResearchFacetCue(message = "") {
    return hasExposureCue(message) || hasAnimalModelCue(message) || hasMechanismCue(message);
}

function tokenize(value = "") {
    return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function unique(values = []) {
    return [...new Set((values || []).filter(Boolean))];
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

function shouldPreservePreviousDisease(message = "", previousMemory = {}) {
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    if (!previousDisease) return false;

    const text = normalizeText(message);
    if (!text) return false;
    if (heuristicDisease(text)) return false;

    if (isLocationOnlyFollowup(message, previousMemory)) {
        return true;
    }

    return FOLLOWUP_CUE_REGEX.test(text) && hasPopulationCue(text);
}

function fallbackTopicDisease(message = "") {
    const text = String(message || "").toLowerCase().trim();
    return heuristicDisease(text);
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

function populationConstraint(message) {
    const text = normalizeText(message);
    const rules = [
        { label: "children", terms: ["children", "child", "pediatric", "paediatric", "adolescent", "infant", "under 5", "u5"] },
        { label: "adults", terms: ["adult", "adults"] },
        { label: "women", terms: ["women", "female", "pregnant"] },
        { label: "men", terms: ["men", "male"] },
        { label: "elderly", terms: ["elderly", "older adults", "geriatric"] }
    ];
    for (const rule of rules) {
        if (rule.terms.some((term) => containsTerm(text, term))) {
            return rule;
        }
    }
    return null;
}

function isBroadDiseaseLabel(value = "") {
    const text = String(value || "").toLowerCase().trim();
    return BROAD_DISEASE_LABELS.has(text);
}

function sameDiseaseTopic(left = "", right = "") {
    const normalizedLeft = String(left || "").toLowerCase().trim().replace(/[’]/g, "'");
    const normalizedRight = String(right || "").toLowerCase().trim().replace(/[’]/g, "'");
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
    if (isBroadDiseaseLabel(normalizedLeft) && normalizedRight.includes(normalizedLeft)) return true;
    if (isBroadDiseaseLabel(normalizedRight) && normalizedLeft.includes(normalizedRight)) return true;

    const leftTokens = tokenize(normalizedLeft).filter((token) => !BROAD_DISEASE_LABELS.has(token));
    const rightTokens = tokenize(normalizedRight).filter((token) => !BROAD_DISEASE_LABELS.has(token));
    if (!leftTokens.length || !rightTokens.length) return false;
    const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length;
    const minimumRequired = Math.max(1, Math.ceil(Math.min(leftTokens.length, rightTokens.length) * 0.5));
    return overlap >= minimumRequired;
}

function isUnsupportedFollowup(message = "", previousMemory = {}) {
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    if (!previousDisease) return false;

    const text = normalizeText(message);
    if (!text) return false;
    if (heuristicDisease(text)) return false;
    if (heuristicLocation(text) || hasPopulationCue(text) || hasSupportedResearchFacetCue(text)) return false;

    const tokens = tokenize(text).filter((token) => !FOLLOWUP_FILLER_TOKENS.has(token));
    return tokens.length > 0 && tokens.length <= 5;
}

function buildDeterministicFollowupContext({ message = "", medicalContext = {}, previousMemory = {} } = {}) {
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    const previousLocation = normalizeText(
        previousMemory?.activeCaseFrame?.location
        || previousMemory?.lastQueryFacets?.location
        || ""
    );
    const text = normalizeText(message);
    if (!previousDisease && !previousLocation) {
        return null;
    }

    const disease = heuristicDisease(text);
    const location = heuristicLocation(text);
    const population = populationConstraint(text)?.label || "";
    const exposureFacets = matchTerms(text, EXPOSURE_CUES);
    const animalFacets = matchTerms(text, ANIMAL_MODEL_CUES);
    const mechanismFacets = matchTerms(text, MECHANISM_CUES);
    const researchFacets = unique([...exposureFacets, ...animalFacets, ...mechanismFacets]);

    if (isLocationOnlyFollowup(message, previousMemory)) {
        return {
            enabled: true,
            reason: "deterministic_location_refinement",
            relation: "location_refinement",
            resolvedDisease: previousDisease,
            resolvedLocation: location || previousLocation,
            resolvedPopulation: "",
            resolvedFacets: [],
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "location refinement"),
            query: normalizeText([previousDisease, location || previousLocation].filter(Boolean).join(" ")),
            attachment: "previous_turn",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.8,
            provider: "heuristic",
            model: "rules"
        };
    }

    const diseaseMatchesPrevious = !!(
        disease
        && previousDisease
        && sameDiseaseTopic(disease, previousDisease)
    );

    if ((animalFacets.length && (!disease || diseaseMatchesPrevious))) {
        return {
            enabled: true,
            reason: "deterministic_animal_model",
            relation: "animal_model",
            resolvedDisease: disease || previousDisease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: population,
            resolvedFacets: unique(["animal model", ...animalFacets]),
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "animal model evidence"),
            query: normalizeText([disease || previousDisease, "animal model", location || previousLocation || ""].filter(Boolean).join(" ")),
            attachment: "previous_turn",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.76,
            provider: "heuristic",
            model: "rules"
        };
    }

    if ((mechanismFacets.length && (!disease || diseaseMatchesPrevious))) {
        return {
            enabled: true,
            reason: "deterministic_mechanism_refinement",
            relation: "mechanism_refinement",
            resolvedDisease: disease || previousDisease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: population,
            resolvedFacets: mechanismFacets,
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "mechanism evidence"),
            query: normalizeText([disease || previousDisease, "mechanism", ...mechanismFacets, location || previousLocation || ""].filter(Boolean).join(" ")),
            attachment: "previous_turn",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.76,
            provider: "heuristic",
            model: "rules"
        };
    }

    if ((exposureFacets.length && (!disease || diseaseMatchesPrevious))) {
        return {
            enabled: true,
            reason: "deterministic_exposure_refinement",
            relation: "exposure_refinement",
            resolvedDisease: disease || previousDisease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: population,
            resolvedFacets: exposureFacets,
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "exposure evidence"),
            query: normalizeText([disease || previousDisease, ...exposureFacets, location || previousLocation || ""].filter(Boolean).join(" ")),
            attachment: "previous_turn",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.76,
            provider: "heuristic",
            model: "rules"
        };
    }

    if ((population && (!disease || diseaseMatchesPrevious || FOLLOWUP_CUE_REGEX.test(text)))) {
        return {
            enabled: true,
            reason: "deterministic_population_refinement",
            relation: "population_refinement",
            resolvedDisease: disease || previousDisease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: population,
            resolvedFacets: [],
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "population refinement"),
            query: normalizeText([disease || previousDisease, population, location || previousLocation || ""].filter(Boolean).join(" ")),
            attachment: "previous_turn",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.76,
            provider: "heuristic",
            model: "rules"
        };
    }

    if (disease && previousDisease) {
        const sameTopic = diseaseMatchesPrevious;
        return {
            enabled: true,
            reason: sameTopic ? "deterministic_same_topic" : "deterministic_new_disease",
            relation: sameTopic ? "same_topic" : "new_disease",
            resolvedDisease: disease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: population,
            resolvedFacets: researchFacets,
            intent: normalizeText(medicalContext?.intent || previousMemory?.lastAnswerFocus || "clinical question"),
            query: normalizeText([disease, population, ...researchFacets, location || previousLocation || ""].filter(Boolean).join(" ")),
            attachment: "new_subintent",
            shouldRefetch: true,
            shouldClarify: false,
            confidence: 0.78,
            provider: "heuristic",
            model: "rules"
        };
    }

    if (isUnsupportedFollowup(message, previousMemory)) {
        return {
            enabled: true,
            reason: "deterministic_followup_clarify",
            relation: "clarify",
            resolvedDisease: previousDisease,
            resolvedLocation: location || previousLocation || "",
            resolvedPopulation: "",
            resolvedFacets: [],
            intent: "clarification needed",
            query: "",
            attachment: "out_of_scope",
            shouldRefetch: false,
            shouldClarify: true,
            confidence: 0.62,
            provider: "heuristic",
            model: "rules"
        };
    }

    return null;
}

function buildFollowupMemorySummary(previousMemory = {}) {
    const parts = [];
    const disease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    const location = normalizeText(
        previousMemory?.activeCaseFrame?.location
        || previousMemory?.lastQueryFacets?.location
        || ""
    );
    const focus = normalizeText(previousMemory?.lastAnswerFocus || "");
    const answerSummary = normalizeText(previousMemory?.lastAnswerSummary || "");
    const retrievedIds = Array.isArray(previousMemory?.lastRetrievedIds) ? previousMemory.lastRetrievedIds : [];
    if (answerSummary) {
        parts.push(`Last answer: ${answerSummary.slice(0, 220)}`);
    }
    if (disease || location) {
        parts.push(`Active frame disease=${disease || ""}, location=${location || ""}`);
    }
    if (focus) {
        parts.push(`Last answer focus: ${focus}`);
    }
    if (retrievedIds.length) {
        parts.push(`Recent evidence ids: ${retrievedIds.slice(0, 4).join(", ")}`);
    }
    return parts.join(" | ").trim();
}

function normalizeFollowupContextResponse(payload = {}) {
    const relation = normalizeText(payload?.relation).toLowerCase().replace(/\s+/g, "_");
    const resolvedFacetsRaw = payload?.resolved_facets;
    const resolvedFacets = Array.isArray(resolvedFacetsRaw)
        ? unique(resolvedFacetsRaw.map((item) => normalizeText(item)).filter(Boolean))
        : [];
    const attachment = normalizeText(payload?.attachment).toLowerCase();
    return {
        enabled: !!payload?.enabled,
        reason: normalizeText(payload?.reason || payload?.explanation || ""),
        relation: FOLLOWUP_REFINE_RELATIONS.has(relation) ? relation : "same_topic",
        resolvedDisease: normalizeText(payload?.resolved_disease || ""),
        resolvedLocation: normalizeText(payload?.resolved_location || ""),
        resolvedPopulation: normalizeText(payload?.resolved_population || ""),
        resolvedFacets,
        clarificationType: normalizeText(payload?.clarification_type || payload?.clarify_type || "").toLowerCase().replace(/\s+/g, "_"),
        clarifyPrompt: normalizeText(payload?.clarify_prompt || payload?.clarification_prompt || ""),
        intent: normalizeText(payload?.intent || ""),
        query: normalizeText(payload?.query || ""),
        attachment: ["root", "previous_turn", "new_subintent", "out_of_scope"].includes(attachment)
            ? attachment
            : "",
        shouldRefetch: !!payload?.should_refetch,
        shouldClarify: !!payload?.should_clarify,
        confidence: Number(payload?.confidence || 0),
        provider: normalizeText(payload?.provider || ""),
        model: normalizeText(payload?.model || "")
    };
}

async function classifyFollowupContextWithLLM({
    message = "",
    medicalContext = {},
    previousMemory = {}
}) {
    const previousDisease = normalizeText(
        previousMemory?.activeCaseFrame?.disease
        || previousMemory?.lastQueryFacets?.disease
        || ""
    );
    const previousLocation = normalizeText(
        previousMemory?.activeCaseFrame?.location
        || previousMemory?.lastQueryFacets?.location
        || ""
    );
    const hasPreviousContext = !!(
        previousDisease
        || previousLocation
        || normalizeText(previousMemory?.lastAnswerSummary || "")
        || (previousMemory?.lastRetrievedIds || []).length
        || (previousMemory?.lastRetrievedEvidence || []).length
    );
    if (!hasPreviousContext) {
        return {
            enabled: false,
            reason: "no_previous_context",
            relation: "same_topic",
            resolvedDisease: "",
            resolvedLocation: "",
            resolvedPopulation: "",
            resolvedFacets: [],
            clarificationType: "",
            clarifyPrompt: "",
            intent: "",
            query: "",
            attachment: "root",
            shouldRefetch: false,
            shouldClarify: false,
            confidence: 0,
            provider: "",
            model: ""
        };
    }

    try {
        const response = await fetch(`${getIngestionBaseUrl()}/classify-followup-context`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message,
                disease: normalizeText(
                    medicalContext?.disease
                    || previousDisease
                ),
                location: normalizeText(
                    medicalContext?.location
                    || previousLocation
                ),
                root_intent: normalizeText(
                    medicalContext?.intent
                    || previousMemory?.activeCaseFrame?.intent
                    || previousMemory?.lastQueryFacets?.retrievalMode
                    || ""
                ),
                previous_intent: normalizeText(previousMemory?.intents?.slice(-1)[0] || ""),
                conversation_summary: buildFollowupMemorySummary(previousMemory),
                last_answer_summary: normalizeText(previousMemory?.lastAnswerSummary || ""),
                last_answer_focus: normalizeText(previousMemory?.lastAnswerFocus || ""),
                has_previous_context: hasPreviousContext
            })
        });
        if (!response.ok) {
            throw new Error(`classify-followup-context failed with status ${response.status}`);
        }
        const payload = await response.json();
        return normalizeFollowupContextResponse(payload);
    } catch (error) {
        return {
            enabled: false,
            reason: `error:${error.message}`,
            relation: "same_topic",
            resolvedDisease: "",
            resolvedLocation: "",
            resolvedPopulation: "",
            resolvedFacets: [],
            clarificationType: "",
            clarifyPrompt: "",
            intent: "",
            query: "",
            attachment: "root",
            shouldRefetch: false,
            shouldClarify: false,
            confidence: 0,
            provider: "",
            model: ""
        };
    }
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

    let followupContext = null;
    const hasPreviousContext = !!(
        previousDisease
        || normalizeText(previousMemory?.activeCaseFrame?.location || previousMemory?.lastQueryFacets?.location || "")
        || normalizeText(previousMemory?.lastAnswerSummary || "")
        || (previousMemory?.lastRetrievedIds || []).length
        || (previousMemory?.lastRetrievedEvidence || []).length
    );
    const deterministicFollowupContext = hasPreviousContext
        ? buildDeterministicFollowupContext({
            message,
            medicalContext: {
                ...medicalContext,
                disease,
                location,
                intent
            },
            previousMemory
        })
        : null;
    const unsupportedFollowup = hasPreviousContext && isUnsupportedFollowup(message, previousMemory);
    if (hasPreviousContext) {
        const llmFollowup = await classifyFollowupContextWithLLM({
            message,
            medicalContext: {
                ...medicalContext,
                disease,
                location,
                intent
            },
            previousMemory
        });
        const clarifyOverride = unsupportedFollowup || deterministicFollowupContext?.relation === "clarify";
        if (llmFollowup.enabled || deterministicFollowupContext || clarifyOverride) {
            followupContext = (clarifyOverride || !llmFollowup.enabled)
                ? (deterministicFollowupContext || {
                    enabled: true,
                    reason: "deterministic_followup_clarify",
                    relation: "clarify",
                    resolvedDisease: previousDisease,
                    resolvedLocation: heuristicLocation(message) || normalizeText(previousMemory?.activeCaseFrame?.location || previousMemory?.lastQueryFacets?.location || ""),
                    resolvedPopulation: "",
                    resolvedFacets: [],
                    intent: "clarification needed",
                    query: "",
                    attachment: "out_of_scope",
                    shouldRefetch: false,
                    shouldClarify: true,
                    confidence: 0.62,
                    provider: "heuristic",
                    model: "rules"
                })
                : llmFollowup;
            const followupDisease = normalizeText(followupContext?.resolvedDisease);
            const followupLocation = normalizeText(followupContext?.resolvedLocation);
            const followupIntent = normalizeText(followupContext?.intent || followupContext?.query);
            const preservePreviousDisease = followupContext?.relation !== "new_disease";
            if (preservePreviousDisease) {
                disease = followupDisease || disease || previousDisease;
            } else if (followupDisease) {
                disease = followupDisease;
            }
            if (followupLocation) {
                location = followupLocation;
            }
            if (followupIntent) {
                medicalContext.intent = followupIntent;
            }
            if (followupContext.resolvedFacets?.length && !medicalContext.facets) {
                medicalContext.facets = followupContext.resolvedFacets;
            }
            autofillSource = followupContext?.provider === "heuristic" ? "deterministic_followup" : "llm_followup";
            confidence = Math.max(confidence, followupContext?.confidence || 0.7);
            provider = followupContext?.provider || provider;
            model = followupContext?.model || model;
            reason = reason ? `${reason}|followup_context_${followupContext?.relation || "same_topic"}` : `followup_context_${followupContext?.relation || "same_topic"}`;
        }
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
                if (autofillSource !== "llm_followup") {
                    autofillSource = "llm";
                }
                confidence = llm.confidence || confidence;
                provider = provider || llm.provider;
                model = model || llm.model;
                reason = llm.reason || reason;
            }
        }
    }

    if (shouldPreservePreviousDisease(message, previousMemory)) {
        disease = previousDisease;
        if (autofillSource === "user") {
            autofillSource = "heuristic";
        }
        confidence = Math.max(confidence, 0.8);
        const preserveReason = locationOnlyFollowup
            ? "preserve_previous_disease_for_location_followup"
            : "preserve_previous_disease_for_refinement_followup";
        reason = reason ? `${reason}|${preserveReason}` : preserveReason;
    }

    if (!disease) {
        disease = fallbackTopicDisease(message);
        if (disease) {
            autofillSource = autofillSource === "user" ? "heuristic" : autofillSource;
            confidence = Math.max(confidence, 0.4);
            reason = reason ? `${reason}|topic_fallback` : "topic_fallback";
        }
    }

    const needsClarification = !disease
        || isGenericDiseaseLabel(disease)
        || !!followupContext?.shouldClarify
        || followupContext?.relation === "clarify"
        || followupContext?.relation === "out_of_scope";
    return {
        medicalContext: {
            ...medicalContext,
            disease: disease || "",
            location: location || "",
            intent: normalizeText(medicalContext?.intent || intent || ""),
            followupContext: followupContext || null
        },
        meta: {
            autofillSource,
            confidence: Number(confidence || 0),
            reason,
            provider,
            model,
            needsClarification,
            followupRelation: followupContext?.relation || "",
            followupShouldClarify: !!followupContext?.shouldClarify || followupContext?.relation === "clarify" || followupContext?.relation === "out_of_scope"
        }
    };
}

module.exports = {
    autofillMedicalContext
};
