function normalizeText(value) {
    return String(value || "").toLowerCase().trim();
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
    const disease = intent.disease || previousMemory.lastQueryFacets?.disease || "";
    const location = intent.location?.normalized || previousMemory.lastQueryFacets?.location || "";
    const focus = mapFocusToIntentText(previousMemory.lastAnswerFocus || previousMemory.lastQueryFacets?.retrievalMode || "")
        || String(previousMemory.intents?.slice(-1)[0] || "").trim();
    const population = constraint?.label || "";
    const age = ageConstraint(intent.normalizedMessage || intent.intent || "");
    return cleanQuery([disease, focus, population, age, location].filter(Boolean).join(" "));
}

function extractMedicalIntentTerms(message) {
    const text = normalizeText(message);
    const terms = [];
    const vocabulary = [
        "smoking", "tobacco", "nicotine", "risk", "risk factor", "cause", "causality",
        "outcome", "outcomes", "mortality", "incidence", "prevalence", "women", "men",
        "children", "adults", "wild", "animals", "wildlife", "lung cancer"
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
        "vitamin d", "supplement", "supplementation", "treated", "treat"
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

async function classifyIntentAttachmentWithLLM({ message, intent, previousMemory, turns }) {
    const { lastTurnIntent, lastTurnMessage } = getLastTurnContext(turns, previousMemory);
    const response = await fetch(`${getIngestionBaseUrl()}/classify-intent-attachment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            message: message || "",
            root_intent: previousMemory.intents?.[0] || previousMemory.lastQueryFacets?.retrievalMode || intent.intent || "",
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

function refineEvidencePool(pool, constraint) {
    const refined = pool.map((item) => {
        const match = matchConstraint(item, constraint);
        const boostedScore = Number(item.score || 0) + (match.matched ? 0.35 : -0.15);
        return {
            ...item,
            tier: match.matched ? (item.tier === "tier1" ? "tier1" : "tier2") : "tier3",
            score: boostedScore,
            reuseMatch: {
                matched: match.matched,
                terms: match.matchedTerms
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
    if (reasoningHead?.enabled) {
        const pool = getMemoryEvidencePool(previousMemory, turns);
        const constraint = populationConstraint(message);
        const age = ageConstraint(message);
        const reconstructedQuery = cleanQuery(
            reasoningHead.refined_query
            || [intent.disease, message, intent.location?.normalized].filter(Boolean).join(" ")
        );
        const isFollowup = !!reasoningHead.is_followup;
        const { refined, matchedCount, coverageScore } = refineEvidencePool(pool, constraint);
        const minMatchedForReuse = Number(process.env.FOLLOWUP_REUSE_MIN_MATCHED || 5);
        const hardRefetchByMatchCount = matchedCount <= (minMatchedForReuse - 1);
        const shouldRefetch = (reasoningHead.should_refetch !== false) || hardRefetchByMatchCount;

        const fetchIntent = {
            ...intent,
            intent: reconstructedQuery || intent.intent,
            retrievalQuery: reconstructedQuery || intent.intent
        };

        return {
            isFollowup,
            reconstructedQuery,
            constraint: constraint?.label || "",
            ageConstraint: age,
            shouldRefetch,
            followupDecisionReason: "unified_reasoning_head",
            reuseReason: shouldRefetch ? (pool.length ? "reasoning_head_refetch" : "reasoning_head_empty_refetch") : "reasoning_head_reuse",
            reuseStats: {
                poolCount: pool.length,
                matchedCount,
                coverageScore: Number(coverageScore.toFixed(3))
            },
            reusedEvidence: refined,
            fetchIntent,
            expansion: {
                used: false,
                reason: "covered_by_reasoning_head",
                fallbackUsed: false,
                expandedQuery: "",
                keywords: extractMedicalIntentTerms(message)
            },
            attachment: {
                enabled: true,
                reason: reasoningHead.reason || "ok",
                attachment: reasoningHead.attachment || "root",
                intent: reasoningHead.intent || "",
                query: reconstructedQuery,
                confidence: Number(reasoningHead.confidence || 0),
                explanation: reasoningHead.explanation || "",
                provider: reasoningHead.provider || "",
                model: reasoningHead.model || ""
            },
            forceOutOfScope: reasoningHead.attachment === "out_of_scope" && !isLikelyMedicalFollowup(message, intent.disease || previousMemory.lastQueryFacets?.disease || "")
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
            forceOutOfScope: false
        };
    }

    const constraint = populationConstraint(message);
    const age = ageConstraint(message);
    const reconstructedRootQuery = reconstructQuery(intent, previousMemory, constraint);

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
    let reconstructedQuery = reconstructedRootQuery;
    if (attachmentMeta.attachment === "previous_turn") {
        reconstructedQuery = cleanQuery([
            intent.disease || previousMemory.lastQueryFacets?.disease || "",
            lastTurnIntent || previousMemory.intents?.slice(-1)[0] || "",
            message,
            intent.location?.normalized || previousMemory.lastQueryFacets?.location || ""
        ].filter(Boolean).join(" "));
    } else if (attachmentMeta.attachment === "new_subintent") {
        reconstructedQuery = cleanQuery(attachmentMeta.query || [
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
            forceOutOfScope: true
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

    const pool = getMemoryEvidencePool(previousMemory, turns);
    const { refined, matchedCount, coverageScore } = refineEvidencePool(pool, constraint);
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
        forceOutOfScope: false
    };
}

module.exports = {
    planFollowupReuse,
    mergeEvidencePools
};
