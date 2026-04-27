function normalizeText(value) {
    return String(value || "").toLowerCase().trim().replace(/[’]/g, "'");
}

function normalizeDiseaseTopic(value = "") {
    let text = normalizeText(value);
    text = text
        .replace(/\bnon[-\s]*small[-\s]*cell lung cancer\b/g, "lung cancer")
        .replace(/\bsmall[-\s]*cell lung cancer\b/g, "lung cancer")
        .replace(/\bnsclc\b/g, "lung cancer")
        .replace(/\bparkinson(?:'s|s)\s+disease\b/g, "parkinson disease")
        .replace(/\bparkinson(?:'s|s)?\b(?!\s+disease)/g, "parkinson disease");
    return text.replace(/\s+/g, " ").trim();
}

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

function diseaseTokens(value = "") {
    return normalizeDiseaseTopic(value).split(/[^a-z0-9]+/).filter((token) => token.length > 2);
}

function extractFrameAnchors(text = "") {
    const normalized = normalizeText(text);
    if (!normalized) {
        return {
            stage: "",
            pdl1: "",
            postCrt: false,
            postDurvalumab: false,
            surveillance: false
        };
    }

    const stageMatch = normalized.match(/\bstage\s+([ivx]+[a-c]?|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?[a-c]?)\b/i);
    const stageRaw = stageMatch ? String(stageMatch[1]) : "";
    const stage = stageRaw && /^[ivx]/i.test(stageRaw)
        ? `stage ${stageRaw.toUpperCase()}`
        : (stageRaw ? `stage ${stageRaw}` : "");
    const pdl1Match = normalized.match(/pd[-\s]?l1[^0-9]*(\d{1,3})\s*%/i);

    return {
        stage,
        pdl1: pdl1Match ? `PD-L1 ${pdl1Match[1]}%` : "",
        postCrt: /post chemoradiation|post[-\s]?crt/.test(normalized),
        postDurvalumab: /post durvalumab/.test(normalized),
        surveillance: /surveillance/.test(normalized)
    };
}

function isBroadDiseaseTopic(value = "") {
    const normalized = normalizeDiseaseTopic(value);
    if (!normalized) return true;
    if (BROAD_DISEASE_LABELS.has(normalized)) return true;
    const tokens = diseaseTokens(normalized);
    if (!tokens.length) return true;
    if (tokens.length === 1) return true;
    return false;
}

function estimateDiseaseSpecificity(disease = "", message = "", previousFrame = {}) {
    const normalizedDisease = normalizeDiseaseTopic(disease);
    if (!normalizedDisease) return 0;

    let score = isBroadDiseaseTopic(normalizedDisease) ? 0.25 : 0.55;
    if (diseaseTokens(normalizedDisease).length >= 2) {
        score += 0.15;
    }

    const evidenceText = normalizeText([
        message || "",
        previousFrame.intent || "",
        previousFrame.stage || previousFrame.anchors?.stage || "",
        previousFrame.pdl1 || previousFrame.anchors?.pdl1 || "",
        previousFrame.location || ""
    ].join(" "));
    if (/(stage|pd[-\s]?l1|egfr|alk|post[-\s]?durvalumab|post[-\s]?chemoradiation|surveillance|metastatic|recurrent|resectable|adenocarcinoma|wearing[-\s]?off|tremor[-\s]?dominant|hoehn|yahr)/.test(evidenceText)) {
        score += 0.2;
    }

    return Math.max(0, Math.min(1, score));
}

function followupFocusPhrase(value = "") {
    const normalized = normalizeText(value);
    if (normalized.includes("prevalence")) return "prevalence rate";
    if (normalized.includes("intervention")) return "treatment intervention";
    if (normalized.includes("treatment") || normalized.includes("care") || normalized.includes("guidance")) return "treatment guidance";
    return "clinical question";
}

function formatLocationLabel(value = "") {
    const text = normalizeText(value);
    if (!text) return "";
    const lower = text.toLowerCase();
    if (["usa", "u.s.a.", "us"].includes(lower)) return "USA";
    if (["uk", "u.k."].includes(lower)) return "UK";
    if (lower === "eu") return "EU";
    if (lower === "united states") return "United States";
    if (lower === "united kingdom") return "United Kingdom";
    if (!text.includes(" ")) {
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
    return text
        .split(/\s+/)
        .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(" ");
}

function buildClarificationPrompt({
    disease = "",
    location = "",
    clarificationType = "",
    relation = "",
    previousMemory = {},
    resolvedPopulation = ""
} = {}) {
    const normalizedDisease = normalizeDiseaseTopic(
        disease
        || previousMemory.activeCaseFrame?.disease
        || previousMemory.lastQueryFacets?.disease
        || ""
    );
    const normalizedLocation = formatLocationLabel(
        location
        || previousMemory.activeCaseFrame?.location
        || previousMemory.lastQueryFacets?.location
        || ""
    );
    const locationSuffix = normalizedLocation ? ` in ${normalizedLocation}` : "";
    const type = normalizeText(clarificationType).toLowerCase().replace(/\s+/g, "_");
    const populationLabel = normalizeText(resolvedPopulation);

    if (!normalizedDisease) {
        return "Which disease or condition should I keep focused on?";
    }

    if (type === "population_missing" && populationLabel) {
        return `Which population group are you asking about for ${normalizedDisease}${locationSuffix}?`;
    }

    if (type === "location_missing") {
        return `Which location should I keep focused on for ${normalizedDisease}?`;
    }

    if (type === "disease_missing") {
        return "Which disease or condition should I keep focused on?";
    }

    if (normalizedDisease === "cancer") {
        return `Which cancer type or aspect are you asking about${locationSuffix}?`;
    }

    if (isBroadDiseaseTopic(normalizedDisease) || relation === "clarify") {
        return `What aspect of ${normalizedDisease}${locationSuffix} are you asking about?`;
    }

    return `What aspect of ${normalizedDisease}${locationSuffix} are you asking about?`;
}

function normalizeClarificationPrompt(prompt = "", context = {}) {
    const candidate = normalizeText(prompt);
    if (!candidate) {
        return buildClarificationPrompt(context);
    }
    const normalizedDisease = normalizeDiseaseTopic(context.disease || context.previousDisease || "");
    if (normalizedDisease) {
        const awkwardWhichPattern = /^which\s+.+\s+should i keep focused on\??$/i;
        const genericDiseasePattern = /^which\s+(?:disease|condition)\b/i;
        const diseaseNamedPattern = new RegExp(`^which\\s+.*\\b${normalizedDisease.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (awkwardWhichPattern.test(candidate) || genericDiseasePattern.test(candidate) || diseaseNamedPattern.test(candidate)) {
            return buildClarificationPrompt(context);
        }
    }
    return candidate.endsWith("?") ? candidate : `${candidate}?`;
}

const FOLLOWUP_RELATIONS = new Set([
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

function normalizeFollowupRelation(value = "") {
    const normalized = normalizeText(value).toLowerCase().replace(/\s+/g, "_");
    return FOLLOWUP_RELATIONS.has(normalized) ? normalized : "same_topic";
}

function normalizeFollowupContext(value = {}) {
    if (!value || typeof value !== "object") {
        return {
            enabled: false,
            reason: "",
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

    const resolvedFacetsRaw = Array.isArray(value.resolvedFacets)
        ? value.resolvedFacets
        : (Array.isArray(value.resolved_facets) ? value.resolved_facets : []);
    const resolvedFacets = unique(resolvedFacetsRaw.map((item) => normalizeText(item)).filter(Boolean));
    const attachmentRaw = normalizeText(value.attachment || value.attachments || "").toLowerCase();
    const relation = normalizeFollowupRelation(value.relation || value.followupRelation || "");

    return {
        enabled: !!value.enabled,
        reason: normalizeText(value.reason || value.explanation || ""),
        relation,
        resolvedDisease: normalizeDiseaseTopic(value.resolvedDisease || value.resolved_disease || ""),
        resolvedLocation: normalizeText(value.resolvedLocation || value.resolved_location || ""),
        resolvedPopulation: normalizeText(value.resolvedPopulation || value.resolved_population || ""),
        resolvedFacets,
        clarificationType: normalizeText(value.clarificationType || value.clarification_type || value.clarifyType || "").toLowerCase().replace(/\s+/g, "_"),
        clarifyPrompt: normalizeText(value.clarifyPrompt || value.clarify_prompt || value.clarificationPrompt || ""),
        intent: normalizeText(value.intent || ""),
        query: normalizeText(value.query || ""),
        attachment: ["root", "previous_turn", "new_subintent", "out_of_scope"].includes(attachmentRaw)
            ? attachmentRaw
            : "",
        shouldRefetch: !!value.shouldRefetch || !!value.should_refetch,
        shouldClarify: !!value.shouldClarify || !!value.should_clarify,
        confidence: Number(value.confidence || 0),
        provider: normalizeText(value.provider || ""),
        model: normalizeText(value.model || "")
    };
}

function sameDiseaseTopic(left = "", right = "") {
    const normalizedLeft = normalizeDiseaseTopic(left);
    const normalizedRight = normalizeDiseaseTopic(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;

    const leftTokens = diseaseTokens(normalizedLeft);
    const rightTokens = diseaseTokens(normalizedRight);
    if (!leftTokens.length || !rightTokens.length) return false;

    const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length;
    const minimumRequired = Math.max(1, Math.ceil(Math.min(leftTokens.length, rightTokens.length) * 0.5));
    return overlap >= minimumRequired;
}

function currentDiseaseTopic(intent = {}, previousMemory = {}) {
    const current = normalizeDiseaseTopic(
        intent.disease
        || intent.followupContext?.resolvedDisease
        || ""
    );
    if (current) return current;
    return normalizeDiseaseTopic(previousMemory.activeCaseFrame?.disease || "");
}

function hasTopicShift(message = "", intent = {}, previousMemory = {}) {
    const currentTopic = currentDiseaseTopic(intent, previousMemory);
    const previousTopic = normalizeDiseaseTopic(
        previousMemory.activeCaseFrame?.disease
        || ""
    ) || normalizeDiseaseTopic(
        previousMemory.lastQueryFacets?.disease
        || ""
    );
    if (!currentTopic || !previousTopic) return false;
    if (sameDiseaseTopic(currentTopic, previousTopic)) return false;

    const messageText = normalizeDiseaseTopic(message);
    const currentTerms = diseaseTokens(currentTopic);
    const previousTerms = diseaseTokens(previousTopic);
    const currentMentioned = messageText.includes(currentTopic) || currentTerms.some((term) => messageText.includes(term));
    const previousMentioned = messageText.includes(previousTopic) || previousTerms.some((term) => messageText.includes(term));
    return currentMentioned && !previousMentioned;
}

function tokenize(text = "") {
    return normalizeText(text).split(/[^a-z0-9]+/).filter(Boolean);
}

function containsTerm(text, term) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) return false;
    if (normalizedTerm.includes(" ")) {
        return normalizeText(text).includes(normalizedTerm);
    }
    const tokens = tokenize(text);
    return tokens.includes(normalizedTerm);
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

function cleanQuery(text = "") {
    const tokens = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    return unique(tokens).join(" ").trim();
}

function mapFocusToIntentText(focus = "") {
    const normalized = normalizeText(focus);
    if (normalized === "prevalence") return "prevalence rate";
    if (normalized === "intervention") return "treatment intervention";
    if (normalized === "treatment") return "treatment guidance";
    return "clinical question";
}

function mapPlatformToSource(platform = "") {
    const normalized = normalizeText(platform);
    if (normalized.includes("pubmed")) return "pubmed";
    if (normalized.includes("clinicaltrials")) return "clinicaltrials";
    if (normalized.includes("openalex")) return "openalex";
    return "pubmed";
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

function ageConstraint(message) {
    const text = normalizeText(message);
    const match = text.match(/(above|over|under|below)\s+(\d{1,2})/);
    if (!match) return "";
    const direction = match[1];
    const age = Number(match[2]);
    if (!Number.isFinite(age)) return "";
    if (direction === "above" || direction === "over") {
        return `age above ${age}`;
    }
    return `age below ${age}`;
}

function hasPriorSessionContext(previousMemory = {}, turns = []) {
    const hasMemorySignals = !!(
        String(previousMemory.lastAnswerSummary || "").trim()
        || (previousMemory.lastRetrievedIds || []).length
        || (previousMemory.lastRetrievedEvidence || []).length
        || previousMemory.lastQueryFacets?.disease
    );
    const hasAssistantTurns = (turns || []).some((turn) => turn.role === "assistant");
    return hasMemorySignals || hasAssistantTurns;
}

function detectFollowupDecision(message, intent, previousMemory = {}, turns = []) {
    const text = normalizeText(message);
    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    const hasPreviousContext = hasPriorSessionContext(previousMemory, turns);
    if (!hasPreviousContext) {
        return { isFollowup: false, decisionReason: "first_turn_guard" };
    }
    if (hasTopicShift(message, intent, previousMemory)) {
        return { isFollowup: false, decisionReason: "topic_shift_new_root" };
    }
    if (/^(what about|how about|and |what of|in |for |how does|is there|recheck|rechek|explain|elaborate)/.test(text)) {
        return { isFollowup: true, decisionReason: "followup_phrase_with_prior_context" };
    }
    if (populationConstraint(text)) {
        return { isFollowup: true, decisionReason: "population_refinement_with_prior_context" };
    }
    if (tokens.length <= 8 && !text.includes(normalizeText(intent.disease || ""))) {
        return { isFollowup: true, decisionReason: "short_query_with_prior_context" };
    }
    return { isFollowup: false, decisionReason: "standalone_query" };
}

function reconstructQuery(intent, previousMemory, constraint) {
    const followupContext = normalizeFollowupContext(intent.followupContext || previousMemory.activeCaseFrame?.followupContext || {});
    const disease = normalizeDiseaseTopic(
        followupContext.resolvedDisease
        || intent.disease
        || previousMemory.lastQueryFacets?.disease
        || ""
    );
    const location = followupContext.resolvedLocation || intent.location?.normalized || previousMemory.lastQueryFacets?.location || "";
    const focus = normalizeText(
        followupContext.intent
        || mapFocusToIntentText(previousMemory.lastAnswerFocus || previousMemory.lastQueryFacets?.retrievalMode || "")
        || String(previousMemory.intents?.slice(-1)[0] || "").trim()
    );
    const population = followupContext.resolvedPopulation || constraint?.label || "";
    const facetText = unique(followupContext.resolvedFacets || []).join(" ");
    const age = ageConstraint(intent.normalizedMessage || intent.intent || "");
    const queryBase = followupContext.query || [disease, focus, population, facetText, location].filter(Boolean).join(" ");
    return cleanQuery([queryBase, age].filter(Boolean).join(" "));
}

function evidenceMatchesCurrentTopic(item, intent = {}) {
    const disease = currentDiseaseTopic(intent, {});
    if (!disease) return true;

    const evidenceText = normalizeDiseaseTopic([
        item.title || "",
        item.snippet || "",
        ...(item.evidenceSentences || []),
        ...(item.matchedSentences || [])
    ].join(" "));
    const topicTerms = diseaseTokens(disease);
    if (!topicTerms.length) return true;

    const covered = topicTerms.filter((term) => evidenceText.includes(term)).length;
    const requiredCoverage = topicTerms.length >= 3 ? 2 : topicTerms.length;
    return covered >= requiredCoverage;
}

function extractMedicalIntentTerms(message) {
    const text = normalizeText(message);
    const terms = [];
    const vocabulary = [
        "smoking", "tobacco", "nicotine", "risk", "risk factor", "cause", "causality",
        "outcome", "outcomes", "mortality", "incidence", "prevalence", "women", "men",
        "children", "adults", "wild", "animals", "wildlife", "football", "head injury",
        "head impacts", "mouse", "mice", "rat", "rats", "preclinical", "animal model",
        "mechanism", "pathophysiology", "biomarker", "lung cancer"
    ];
    for (const term of vocabulary) {
        if (containsTerm(text, term)) terms.push(term);
    }
    return unique(terms);
}

function isLikelyMedicalFollowup(message = "", disease = "") {
    const text = normalizeText(message);
    const medicalTerms = [
        "disease", "treatment", "therapy", "clinical", "trial", "study", "evidence",
        "prevalence", "incidence", "risk", "factor", "cause", "causes", "causality",
        "outcome", "outcomes", "mortality", "survival", "women", "men", "children",
        "adult", "adults", "smoking", "tobacco", "nicotine", "cancer", "infection",
        "vitamin d", "supplement", "supplementation", "treated", "treat",
        "football", "head injury", "head impacts", "animals", "animal model",
        "mouse", "mice", "rat", "rats", "preclinical", "mechanism", "pathophysiology",
        "biomarker"
    ];
    if (normalizeText(disease) && text.includes(normalizeText(disease))) {
        return true;
    }
    return medicalTerms.some((term) => text.includes(term));
}

function shouldUseLLMExpansion({ query, extractedTerms, isFollowup }) {
    const tokenCount = normalizeText(query).split(/\s+/).filter(Boolean).length;
    const followupPhrase = /^(what about|how about|and |in |for |recheck|rechek|explain|elaborate)/.test(normalizeText(query));
    return !!(
        isFollowup &&
        (
            tokenCount <= 8
            || extractedTerms.length === 0
            || followupPhrase
        )
    );
}

function buildConversationSummary(previousMemory = {}, turns = []) {
    const parts = [];
    if (previousMemory.lastAnswerSummary) {
        parts.push(`Last answer: ${String(previousMemory.lastAnswerSummary).slice(0, 280)}`);
    }
    if (previousMemory.lastQueryFacets?.disease || previousMemory.lastQueryFacets?.location) {
        parts.push(`Last facets disease=${previousMemory.lastQueryFacets?.disease || ""}, location=${previousMemory.lastQueryFacets?.location || ""}`);
    }
    const lastUser = (turns || []).filter((turn) => turn.role === "user").slice(-1)[0];
    if (lastUser?.message) {
        parts.push(`Last user message: ${String(lastUser.message).slice(0, 180)}`);
    }
    return parts.join(" | ").trim();
}

function getLastTurnContext(turns = [], previousMemory = {}) {
    const lastUser = (turns || []).filter((turn) => turn.role === "user").slice(-1)[0] || {};
    const lastTurnIntent = String(lastUser?.intent?.intent || previousMemory.intents?.slice(-1)[0] || "").trim();
    const lastTurnMessage = String(lastUser?.message || "").trim();
    return { lastTurnIntent, lastTurnMessage };
}

function buildConversationFrame({ message = "", intent = {}, previousMemory = {}, turns = [] } = {}) {
    const normalizedMessage = normalizeText(message);
    const previousFrame = previousMemory.activeCaseFrame || {};
    const followupContext = normalizeFollowupContext(intent.followupContext || previousFrame.followupContext || {});
    const explicitDisease = normalizeDiseaseTopic(
        intent.disease
        || followupContext.resolvedDisease
        || ""
    );
    const previousDisease = normalizeDiseaseTopic(
        previousFrame.disease
        || previousMemory.lastQueryFacets?.disease
        || previousMemory.conditions?.slice(-1)[0]
        || ""
    );
    const disease = explicitDisease || previousDisease;
    const previousLocation = normalizeText(previousFrame.location || previousMemory.lastQueryFacets?.location || "");
    const currentLocation = normalizeText(
        followupContext.resolvedLocation
        || intent.location?.normalized
        || previousLocation
        || ""
    );
    const locationChanged = !!currentLocation && !!previousLocation && currentLocation !== previousLocation;
    const followupPhrase = /^(what about|how about|and |what of|in |for |how does|is there|recheck|rechek|explain|elaborate)/.test(normalizedMessage);
    const explicitDiseaseShift = !!explicitDisease && !!previousDisease && !sameDiseaseTopic(explicitDisease, previousDisease);
    const anchors = extractFrameAnchors([normalizedMessage, intent.intent || "", previousFrame.intent || "", followupContext.query || ""].join(" "));
    const specificity = estimateDiseaseSpecificity(disease, normalizedMessage, {
        ...previousFrame,
        ...anchors,
        location: currentLocation
    });
    const isBroad = specificity < 0.45 || isBroadDiseaseTopic(disease);
    const relation = followupContext.enabled
        ? followupContext.relation
        : (explicitDiseaseShift
            ? "new_disease"
            : (followupPhrase && locationChanged ? "location_refinement" : (followupPhrase ? "same_topic" : "root")));
    const resolvedPopulation = normalizeText(
        followupContext.resolvedPopulation
        || populationConstraint(normalizedMessage)?.label
        || ""
    );
    const resolvedFacets = unique(followupContext.resolvedFacets || []);
    const clarifyNeeded = !!followupContext.shouldClarify
        || relation === "clarify"
        || (relation === "location_refinement" && isBroad && !anchors.stage && !anchors.pdl1 && !anchors.postCrt && !anchors.postDurvalumab && !anchors.surveillance);
    const retrievalMode = relation === "location_refinement" && !clarifyNeeded
        ? (previousFrame.retrievalMode || intent.retrievalMode || "clinical_guidance")
        : (intent.retrievalMode || previousFrame.retrievalMode || "clinical_guidance");
    const queryIntent = relation === "location_refinement" && !clarifyNeeded
        ? (followupContext.intent || followupFocusPhrase(previousMemory.lastAnswerFocus || previousFrame.lastAnswerFocus || previousMemory.lastQueryFacets?.retrievalMode || intent.intent || ""))
        : (followupContext.intent || intent.intent || previousFrame.intent || "");
    const queryDisease = disease || previousDisease || "";
    const query = cleanQuery([
        followupContext.query || "",
        queryDisease,
        queryIntent,
        resolvedPopulation,
        ...resolvedFacets,
        currentLocation || previousLocation || ""
    ].filter(Boolean).join(" "));

    return {
        disease: queryDisease,
        previousDisease,
        location: currentLocation || previousLocation || "",
        previousLocation,
        intent: queryIntent,
        retrievalMode,
        specificity,
        isBroad,
        relation,
        clarifyNeeded,
        clarifyPrompt: clarifyNeeded
            ? normalizeClarificationPrompt(followupContext.clarifyPrompt || "", {
                disease: queryDisease || previousDisease || "",
                location: currentLocation || previousLocation || "",
                clarificationType: followupContext.clarificationType || "",
                relation,
                previousMemory,
                resolvedPopulation,
            })
            : "",
        query,
        stage: anchors.stage,
        pdl1: anchors.pdl1,
        postCrt: anchors.postCrt,
        postDurvalumab: anchors.postDurvalumab,
        surveillance: anchors.surveillance,
        anchors,
        resolvedPopulation,
        resolvedFacets,
        followupContext: followupContext.enabled ? followupContext : null,
        intentOverrides: clarifyNeeded
            ? {}
            : {
                disease: queryDisease,
                location: currentLocation || previousLocation ? { ...(intent.location || {}), normalized: currentLocation || previousLocation || "" } : intent.location,
                intent: queryIntent,
                retrievalMode,
                population: resolvedPopulation,
                facets: resolvedFacets,
                followupContext: followupContext.enabled ? followupContext : null
            },
        frameSource: followupContext.enabled
            ? "llm_followup_semantics"
            : (relation === "location_refinement" ? "location_refinement" : (explicitDiseaseShift ? "disease_shift" : "current_turn"))
    };
}

async function classifyIntentAttachmentWithLLM({ message, intent, previousMemory, turns }) {
    const { lastTurnIntent, lastTurnMessage } = getLastTurnContext(turns, previousMemory);
    const currentRootIntent = String(
        intent?.disease
        || intent?.intent
        || previousMemory.lastQueryFacets?.disease
        || previousMemory.intents?.slice(-1)[0]
        || ""
    ).trim();
    const previousRootIntent = String(
        previousMemory.lastQueryFacets?.disease
        || previousMemory.intents?.slice(-1)[0]
        || intent?.intent
        || ""
    ).trim();
    const response = await fetch(`${getIngestionBaseUrl()}/classify-intent-attachment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            message: message || "",
            root_intent: currentRootIntent,
            conversation_summary: buildConversationSummary(previousMemory, turns),
            last_turn_intent: lastTurnIntent,
            last_turn_message: lastTurnMessage,
            disease: intent.disease || previousMemory.lastQueryFacets?.disease || "",
            location: intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
        })
    });
    if (!response.ok) {
        throw new Error(`classify-intent-attachment failed with status ${response.status}`);
    }
    return response.json();
}

async function expandQueryWithLLM({ message, disease, previousIntent, location, baseQuery }) {
    const response = await fetch(`${getIngestionBaseUrl()}/expand-followup-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            message,
            disease: disease || "",
            previous_intent: previousIntent || "",
            location: location || "",
            base_query: baseQuery || ""
        })
    });
    if (!response.ok) {
        throw new Error(`expand-followup-query failed with status ${response.status}`);
    }
    return response.json();
}

function normalizeStoredEvidenceItem(item = {}) {
    return {
        id: item.id || "",
        source: item.source || "pubmed",
        title: item.title || "Untitled source",
        snippet: item.snippet || item.supportingSnippet || "",
        evidenceSentences: item.evidenceSentences || (item.supportingSnippet ? [item.supportingSnippet] : []),
        matchedSentences: item.matchedSentences || [],
        authors: item.authors || [],
        year: item.year || null,
        studyType: item.studyType || "",
        tier: item.tier || "tier3",
        score: Number(item.score || 1),
        url: item.url || ""
    };
}

function extractFromSourceMapping(turn = {}) {
    const mappings = Array.isArray(turn.sourceMapping) ? turn.sourceMapping : [];
    const items = [];
    for (const mapping of mappings) {
        const tier = mapping?.tier || "tier3";
        for (const source of mapping?.sources || []) {
            items.push(normalizeStoredEvidenceItem({
                id: source.id,
                source: mapPlatformToSource(source.platform),
                title: source.title,
                snippet: source.supportingSnippet || mapping.statement || "",
                supportingSnippet: source.supportingSnippet || mapping.statement || "",
                evidenceSentences: source.supportingSnippet ? [source.supportingSnippet] : [],
                authors: source.authors || [],
                year: source.year || null,
                studyType: "",
                tier,
                score: tier === "tier1" ? 1.8 : tier === "tier2" ? 1.4 : 1.0,
                url: source.url || ""
            }));
        }
    }
    return items;
}

function getMemoryEvidencePool(previousMemory = {}, turns = []) {
    const fromMemory = Array.isArray(previousMemory.lastRetrievedEvidence)
        ? previousMemory.lastRetrievedEvidence.map(normalizeStoredEvidenceItem).filter((item) => item.id)
        : [];
    if (fromMemory.length) {
        return fromMemory;
    }

    const assistantTurns = (turns || []).filter((turn) => turn.role === "assistant").slice(-3).reverse();
    const fromTurns = assistantTurns.flatMap((turn) => extractFromSourceMapping(turn));
    const deduped = [];
    const seen = new Set();
    for (const item of fromTurns) {
        const key = `${item.source}:${item.id}`;
        if (!item.id || seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
    }
    return deduped;
}

function matchConstraint(item, constraint) {
    if (!constraint) return { matched: true, matchedTerms: [] };
    const text = normalizeText(`${item.title} ${item.snippet} ${(item.evidenceSentences || []).join(" ")}`);
    const matchedTerms = constraint.terms.filter((term) => text.includes(term));
    return {
        matched: matchedTerms.length > 0,
        matchedTerms
    };
}

function refineEvidencePool(pool, constraint, intent = {}) {
    const refined = pool.map((item) => {
        const match = matchConstraint(item, constraint);
        const topicMatch = evidenceMatchesCurrentTopic(item, intent);
        const matched = match.matched && topicMatch;
        const boostedScore = Number(item.score || 0) + (matched ? 0.35 : -0.15);
        return {
            ...item,
            tier: matched ? (item.tier === "tier1" ? "tier1" : "tier2") : "tier3",
            score: boostedScore,
            reuseMatch: {
                matched,
                terms: matched ? match.matchedTerms : [],
                topicMatch
            }
        };
    }).sort((a, b) => b.score - a.score);

    const matchedCount = refined.filter((item) => item.reuseMatch?.matched).length;
    const coverageScore = refined.length ? matchedCount / refined.length : 0;
    return {
        refined,
        matchedCount,
        coverageScore
    };
}

function mergeEvidencePools(primary = [], secondary = []) {
    const merged = [];
    const seen = new Set();
    for (const item of [...primary, ...secondary]) {
        const key = `${item.source}:${item.id}`;
        if (!item?.id || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }
    return merged;
}

async function planFollowupReuse({ message, intent, previousMemory, turns, reasoningHead = null }) {
    const pool = getMemoryEvidencePool(previousMemory, turns);
    const constraint = populationConstraint(message);
    const age = ageConstraint(message);
    const conversationFrame = buildConversationFrame({ message, intent, previousMemory, turns });
    const topicShift = hasTopicShift(message, intent, previousMemory) || conversationFrame.relation === "new_disease";
    const reconstructedRootQuery = conversationFrame.query || reconstructQuery(intent, previousMemory, constraint);

    if (conversationFrame.clarifyNeeded) {
        const clarificationPrompt = normalizeClarificationPrompt(
            followupContext.clarifyPrompt || "",
            {
                disease: conversationFrame.disease || followupContext.resolvedDisease || intent.disease || previousMemory.lastQueryFacets?.disease || "",
                location: conversationFrame.location || followupContext.resolvedLocation || intent.location?.normalized || previousMemory.lastQueryFacets?.location || "",
                clarificationType: followupContext.clarificationType || "",
                relation: conversationFrame.relation || followupContext.relation || "clarify",
                previousMemory,
                resolvedPopulation: followupContext.resolvedPopulation || conversationFrame.resolvedPopulation || ""
            }
        );
        return {
            isFollowup: true,
            reconstructedQuery: "",
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch: false,
            followupDecisionReason: "conversation_frame_clarify",
            reuseReason: "conversation_frame_clarify",
            reuseStats: {
                poolCount: pool.length,
                matchedCount: 0,
                coverageScore: 0
            },
            reusedEvidence: [],
            fetchIntent: {
                ...intent,
                intent: conversationFrame.intent || intent.intent || "",
                retrievalQuery: conversationFrame.query || intent.intent || "",
                retrievalMode: conversationFrame.retrievalMode || intent.retrievalMode || "clinical_guidance"
            },
            expansion: {
                used: false,
                reason: "conversation_frame_clarify",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: extractMedicalIntentTerms(message)
            },
            attachment: {
                enabled: false,
                reason: "conversation_frame_clarify",
                attachment: "root",
                intent: conversationFrame.intent || "",
                query: conversationFrame.query || "",
                confidence: 0
            },
            forceOutOfScope: false,
            frame: conversationFrame,
            clarifyNeeded: true,
            clarifyPrompt: clarificationPrompt
        };
    }

    if (conversationFrame.relation === "out_of_scope") {
        return {
            isFollowup: true,
            reconstructedQuery: "",
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch: false,
            followupDecisionReason: "conversation_frame_out_of_scope",
            reuseReason: "conversation_frame_out_of_scope",
            reuseStats: {
                poolCount: pool.length,
                matchedCount: 0,
                coverageScore: 0
            },
            reusedEvidence: [],
            fetchIntent: {
                ...intent,
                intent: conversationFrame.intent || intent.intent || "",
                retrievalQuery: conversationFrame.query || intent.intent || "",
                retrievalMode: conversationFrame.retrievalMode || intent.retrievalMode || "clinical_guidance"
            },
            expansion: {
                used: false,
                reason: "conversation_frame_out_of_scope",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: extractMedicalIntentTerms(message)
            },
            attachment: {
                enabled: false,
                reason: "conversation_frame_out_of_scope",
                attachment: "out_of_scope",
                intent: conversationFrame.intent || "",
                query: conversationFrame.query || "",
                confidence: 0
            },
            forceOutOfScope: true,
            frame: conversationFrame,
            clarifyNeeded: false
        };
    }

    if (topicShift) {
        const freshQuery = cleanQuery([
            conversationFrame.query || "",
            normalizeDiseaseTopic(intent.disease || ""),
            normalizeDiseaseTopic(message || ""),
            intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
        ].filter(Boolean).join(" "));
        return {
            isFollowup: false,
            reconstructedQuery: freshQuery || reconstructedRootQuery,
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch: true,
            followupDecisionReason: "topic_shift_new_root",
            reuseReason: "new_topic_refetch",
            reuseStats: {
                poolCount: pool.length,
                matchedCount: 0,
                coverageScore: 0
            },
            reusedEvidence: [],
            fetchIntent: {
                ...intent,
                intent: freshQuery || intent.intent,
                retrievalQuery: freshQuery || intent.intent
            },
            expansion: {
                used: false,
                reason: "topic_shift_new_root",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: extractMedicalIntentTerms(message)
            },
            attachment: {
                enabled: false,
                reason: "topic_shift_new_root",
                attachment: "root",
                intent: "",
                query: "",
                confidence: 0
            },
            forceOutOfScope: false,
            frame: conversationFrame,
            clarifyNeeded: false
        };
    }

    if (reasoningHead?.enabled) {
        const frameQuery = conversationFrame.query || reconstructedRootQuery;
        const reconstructedQuery = cleanQuery(
            reasoningHead.refined_query
            || frameQuery
            || [normalizeDiseaseTopic(intent.disease || ""), normalizeDiseaseTopic(message || ""), intent.location?.normalized].filter(Boolean).join(" ")
        );
        const isFollowup = !!reasoningHead.is_followup;
        const { refined, matchedCount, coverageScore } = refineEvidencePool(pool, constraint, intent);
        const minMatchedForReuse = Number(process.env.FOLLOWUP_REUSE_MIN_MATCHED || 5);
        const hardRefetchByMatchCount = matchedCount <= (minMatchedForReuse - 1);
        const locationRefinement = conversationFrame.relation === "location_refinement" && !conversationFrame.clarifyNeeded;
        const shouldRefetch = (reasoningHead.should_refetch !== false) || hardRefetchByMatchCount || topicShift || locationRefinement;
        const attachment = (() => {
            const base = {
                enabled: true,
                reason: reasoningHead.reason || "ok",
                attachment: reasoningHead.attachment || "root",
                intent: reasoningHead.intent || "",
                query: reconstructedQuery,
                confidence: Number(reasoningHead.confidence || 0),
                explanation: reasoningHead.explanation || "",
                provider: reasoningHead.provider || "",
                model: reasoningHead.model || ""
            };
            if (locationRefinement && base.attachment === "new_subintent") {
                return {
                    ...base,
                    attachment: "previous_turn",
                    reason: `${base.reason || "ok"}|conversation_frame_location_refinement`
                };
            }
            return base;
        })();

        const fetchIntent = {
            ...intent,
            intent: locationRefinement && conversationFrame.intent
                ? conversationFrame.intent
                : (conversationFrame.intent || reconstructedQuery || intent.intent),
            retrievalQuery: locationRefinement && conversationFrame.query
                ? conversationFrame.query
                : (conversationFrame.query || reconstructedQuery || intent.intent),
            retrievalMode: locationRefinement
                ? (conversationFrame.retrievalMode || intent.retrievalMode || "clinical_guidance")
                : (intent.retrievalMode || "clinical_guidance")
        };

        return {
            isFollowup,
            reconstructedQuery: locationRefinement ? conversationFrame.query : reconstructedQuery,
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch,
            followupDecisionReason: locationRefinement
                ? "conversation_frame_location_refinement"
                : "unified_reasoning_head",
            reuseReason: shouldRefetch
                ? (topicShift
                    ? "topic_shift_new_root"
                    : (locationRefinement
                        ? "conversation_frame_location_refinement"
                        : (pool.length ? "reasoning_head_refetch" : "reasoning_head_empty_refetch")))
                : "reasoning_head_reuse",
            reuseStats: {
                poolCount: pool.length,
                matchedCount,
                coverageScore: Number(coverageScore.toFixed(3))
            },
            reusedEvidence: topicShift ? [] : refined,
            fetchIntent,
            expansion: {
                used: false,
                reason: locationRefinement ? "conversation_frame_location_refinement" : "covered_by_reasoning_head",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: extractMedicalIntentTerms(message)
            },
            attachment,
            forceOutOfScope: reasoningHead.attachment === "out_of_scope" && !isLikelyMedicalFollowup(message, intent.disease || previousMemory.lastQueryFacets?.disease || ""),
            frame: conversationFrame,
            clarifyNeeded: false
        };
    }

    const followupDecision = detectFollowupDecision(message, intent, previousMemory, turns);
    if (!followupDecision.isFollowup) {
        return {
            isFollowup: false,
            reconstructedQuery: "",
            constraint: null,
            shouldRefetch: true,
            reuseReason: followupDecision.decisionReason || "not_followup",
            followupDecisionReason: followupDecision.decisionReason || "not_followup",
            reusedEvidence: [],
            fetchIntent: intent,
            expansion: {
                used: false,
                reason: "not_followup",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: []
            },
            attachment: {
                enabled: false,
                reason: "not_followup",
                attachment: "root",
                intent: "",
                query: "",
                confidence: 0
            },
            forceOutOfScope: false,
            frame: conversationFrame,
            clarifyNeeded: false
        };
    }

    let attachmentMeta = {
        enabled: false,
        reason: "not_attempted",
        attachment: "root",
        intent: "",
        query: "",
        confidence: 0
    };
    try {
        const llmAttachment = await classifyIntentAttachmentWithLLM({ message, intent, previousMemory, turns });
        if (llmAttachment?.enabled) {
            attachmentMeta = {
                enabled: true,
                reason: llmAttachment.reason || "ok",
                attachment: llmAttachment.attachment || "root",
                intent: llmAttachment.intent || "",
                query: llmAttachment.query || "",
                confidence: Number(llmAttachment.confidence || 0),
                explanation: llmAttachment.explanation || "",
                provider: llmAttachment.provider || "",
                model: llmAttachment.model || ""
            };
        } else {
            attachmentMeta = {
                enabled: false,
                reason: llmAttachment?.reason || "disabled",
                attachment: "root",
                intent: "",
                query: "",
                confidence: 0
            };
        }
    } catch (error) {
        attachmentMeta = {
            enabled: false,
            reason: `error:${error.message}`,
            attachment: "root",
            intent: "",
            query: "",
            confidence: 0
        };
    }

    const { lastTurnIntent } = getLastTurnContext(turns, previousMemory);
    const semanticBaseQuery = conversationFrame.query || reconstructedRootQuery;
    let reconstructedQuery = semanticBaseQuery;
    if (attachmentMeta.attachment === "previous_turn") {
        reconstructedQuery = cleanQuery([
            semanticBaseQuery,
            intent.disease || previousMemory.lastQueryFacets?.disease || "",
            lastTurnIntent || previousMemory.intents?.slice(-1)[0] || "",
            message,
            intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
        ].filter(Boolean).join(" "));
    } else if (attachmentMeta.attachment === "new_subintent") {
        reconstructedQuery = cleanQuery(attachmentMeta.query || [
            semanticBaseQuery,
            intent.disease || previousMemory.lastQueryFacets?.disease || "",
            message,
            intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
        ].filter(Boolean).join(" "));
    } else if (attachmentMeta.attachment === "out_of_scope" && attachmentMeta.confidence >= 0.6) {
        // Guardrail: prevent medical follow-ups from being incorrectly dropped as out_of_scope.
        if (isLikelyMedicalFollowup(message, intent.disease || previousMemory.lastQueryFacets?.disease || "")) {
            attachmentMeta = {
                ...attachmentMeta,
                attachment: "new_subintent",
                reason: `${attachmentMeta.reason || "ok"}|medical_override_new_subintent`,
                confidence: Math.min(Number(attachmentMeta.confidence || 0), 0.59)
            };
            reconstructedQuery = cleanQuery(attachmentMeta.query || [
                semanticBaseQuery,
                intent.disease || previousMemory.lastQueryFacets?.disease || "",
                message,
                intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
            ].filter(Boolean).join(" "));
        } else {
        return {
            isFollowup: true,
            reconstructedQuery: "",
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch: false,
            followupDecisionReason: followupDecision.decisionReason || "followup_detected",
            reuseReason: "attachment_out_of_scope",
            reuseStats: {
                poolCount: 0,
                matchedCount: 0,
                coverageScore: 0
            },
            reusedEvidence: [],
            fetchIntent: intent,
            expansion: {
                used: false,
                reason: "skipped_out_of_scope",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: []
            },
            attachment: attachmentMeta,
            forceOutOfScope: true,
            frame: conversationFrame,
            clarifyNeeded: false
        };
        }
    }

    const extractedTerms = extractMedicalIntentTerms(message);
    const useLLMExpansion = shouldUseLLMExpansion({
        query: message,
        extractedTerms,
        isFollowup: true
    });
    let finalQuery = reconstructedQuery;
    let expansionMeta = {
        used: false,
        reason: useLLMExpansion ? "eligible" : "rule_only",
        fallbackUsed: false,
        expandedQuery: "",
        keywords: extractedTerms
    };
    if (useLLMExpansion) {
        try {
            const llm = await expandQueryWithLLM({
                message,
                disease: intent.disease || previousMemory.lastQueryFacets?.disease || "",
                previousIntent: attachmentMeta.intent || previousMemory.intents?.slice(-1)[0] || intent.intent || "",
                location: intent.location?.normalized || previousMemory.lastQueryFacets?.location || "",
                baseQuery: reconstructedQuery
            });
            if (llm.enabled && llm.expanded_query) {
                finalQuery = cleanQuery(llm.expanded_query);
                expansionMeta = {
                    used: true,
                    reason: llm.reason || "ok",
                    fallbackUsed: false,
                    expandedQuery: finalQuery,
                    keywords: unique([...(extractedTerms || []), ...((llm.keywords || []).map((k) => normalizeText(k)))])
                };
            } else {
                expansionMeta = {
                    used: false,
                    reason: llm.reason || "disabled",
                    fallbackUsed: true,
                    expandedQuery: "",
                    keywords: extractedTerms
                };
            }
        } catch (error) {
            expansionMeta = {
                used: false,
                reason: `error:${error.message}`,
                fallbackUsed: true,
                expandedQuery: "",
                keywords: extractedTerms
            };
        }
    }

    const { refined, matchedCount, coverageScore } = refineEvidencePool(pool, constraint, intent);
    const minTier1 = Number(process.env.FOLLOWUP_REUSE_MIN_MATCHED || 2);
    const minCoverage = Number(process.env.FOLLOWUP_REUSE_MIN_COVERAGE || 0.35);
    const hasReusableCoverage = matchedCount >= minTier1 && coverageScore >= minCoverage;

    const fetchIntent = {
        ...intent,
        intent: finalQuery || intent.intent,
        retrievalQuery: finalQuery || intent.intent,
        tokens: unique([
            ...(intent.tokens || []),
            ...(constraint?.terms || []),
            ...String(age).split(/[^a-z0-9]+/).filter(Boolean),
            ...(expansionMeta.keywords || []).flatMap((term) => String(term).split(/[^a-z0-9]+/).filter(Boolean))
        ])
    };

    return {
        isFollowup: true,
        reconstructedQuery: finalQuery,
        constraint: constraint?.label || "",
        ageConstraint: age,
        shouldRefetch: !hasReusableCoverage,
        followupDecisionReason: followupDecision.decisionReason || "followup_detected",
        reuseReason: hasReusableCoverage
            ? "reuse_sufficient"
            : (pool.length ? "reuse_weak_coverage_refetch" : "reuse_empty_refetch"),
        reuseStats: {
            poolCount: pool.length,
            matchedCount,
            coverageScore: Number(coverageScore.toFixed(3))
        },
        reusedEvidence: refined,
        fetchIntent,
        expansion: expansionMeta,
        attachment: attachmentMeta,
        forceOutOfScope: false,
        frame: conversationFrame,
        clarifyNeeded: false
    };
}

module.exports = {
    planFollowupReuse,
    mergeEvidencePools,
    buildConversationFrame
};
