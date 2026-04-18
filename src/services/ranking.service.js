const SOURCE_WEIGHT = {
    pubmed: 1.0,
    clinicaltrials: 0.8,
    openalex: 0.6
};

const HYDRATION_TERMS = ["hydration", "water", "fluids", "dehydration", "oral intake", "supportive care", "oral rehydration", "fluid therapy"];

function countMatches(text, terms) {
    return (terms || []).filter((term) => term && text.includes(String(term).toLowerCase())).length;
}

function getStudyTypeWeight(item) {
    const studyText = `${item.studyType || ""} ${(item.publicationTypes || []).join(" ")} ${(item.status || "")}`.toLowerCase();
    const llmDocType = String(item?.llmSemantic?.doc_type || "").toLowerCase();

    if (studyText.includes("meta-analysis")) return 0.28;
    if (studyText.includes("systematic review")) return 0.25;
    if (studyText.includes("randomized")) return 0.23;
    if (studyText.includes("interventional")) return 0.2;
    if (studyText.includes("clinical trial")) return 0.18;
    if (studyText.includes("cohort")) return 0.15;
    if (studyText.includes("observational")) return 0.12;
    if (llmDocType === "meta_analysis") return 0.27;
    if (llmDocType === "review") return 0.24;
    if (llmDocType === "randomized_controlled_trial") return 0.23;
    if (llmDocType === "interventional_trial") return 0.2;
    if (llmDocType === "trial_registry") return 0.16;
    return item.source === "pubmed" ? 0.1 : 0.08;
}

function buildIntentKeywords(intent) {
    const keywords = new Set([
        ...(intent.substances || []),
        ...(intent.symptoms || []),
        ...(intent.tokens || []).filter((token) => token !== intent.disease && !(intent.location?.tokens || []).includes(token))
    ]);

    const intentText = String(intent.intent || "").toLowerCase();
    const retrievalMode = String(intent.retrievalMode || "").toLowerCase();
    if (intentText.includes("research") || retrievalMode === "research_summary") {
        ["systematic review", "meta-analysis", "review", "trial"].forEach((term) => keywords.add(term));
    }
    if (intentText.includes("care") || intentText.includes("guidance") || intentText.includes("clinical") || retrievalMode === "clinical_guidance") {
        ["treatment", "management", "supportive care"].forEach((term) => keywords.add(term));
    }
    if (retrievalMode === "ongoing_studies") {
        ["recruiting", "ongoing", "active", "study", "trial", "investigation"].forEach((term) => keywords.add(term));
    }
    if (retrievalMode === "intervention_landscape") {
        ["intervention", "therapy", "tested", "evaluated", "trial"].forEach((term) => keywords.add(term));
    }
    if ((intent.substances || []).some((term) => ["hydration", "water"].includes(term))) {
        ["fluids", "oral intake", "dehydration", "supportive care", "oral rehydration"].forEach((term) => keywords.add(term));
    }

    return [...keywords].filter(Boolean);
}

function buildEvidenceText(item) {
    return `${item.title} ${item.snippet} ${(item.matchedSentences || []).join(" ")} ${(item.evidenceSentences || []).join(" ")}`.toLowerCase();
}

function diseaseMatchesEvidence(intent, evidenceText) {
    const disease = String(intent.disease || "").toLowerCase().trim();
    if (!disease) return true;
    if (evidenceText.includes(disease)) return true;
    const tokens = disease.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    if (!tokens.length) return false;
    const covered = tokens.filter((token) => evidenceText.includes(token)).length;
    const required = tokens.length >= 3 ? 2 : tokens.length;
    return covered >= required;
}

function getSourceSpecificBoost(item, intent) {
    const intentText = String(intent.intent || "").toLowerCase();
    const retrievalMode = String(intent.retrievalMode || "").toLowerCase();
    const studyText = `${item.studyType || ""}`.toLowerCase();
    const isPrimarySource = item.source === intent.sourcePolicy?.primary;
    const isSupplementalSource = item.source === intent.sourcePolicy?.supplemental;
    const llmFocus = String(item?.llmSemantic?.focus || "").toLowerCase();

    if (retrievalMode === "ongoing_studies") {
        if (item.source === "clinicaltrials") {
            if (studyText.includes("interventional") || studyText.includes("trial")) return 0.14;
            return 0.1;
        }
        if (llmFocus === "ongoing_studies") return 0.08;
        return 0.03;
    }

    if (retrievalMode === "intervention_landscape") {
        if (item.source === "clinicaltrials") return 0.12;
        if (studyText.includes("randomized") || studyText.includes("trial")) return 0.08;
        if (llmFocus === "treatment" || llmFocus === "supportive_care") return 0.08;
        return 0.04;
    }

    if (retrievalMode === "research_summary") {
        if (studyText.includes("review") || studyText.includes("meta-analysis")) return 0.12;
        if (llmFocus === "epidemiology") return 0.06;
        return item.source === "pubmed" ? 0.06 : 0.02;
    }

    if (intentText.includes("research")) {
        if (studyText.includes("review") || studyText.includes("meta-analysis")) return 0.1;
        return item.source === "pubmed" ? 0.05 : 0.02;
    }

    if (intentText.includes("care") || intentText.includes("clinical")) {
        if (item.source === "clinicaltrials" && (studyText.includes("interventional") || studyText.includes("trial"))) return 0.08;
        if (studyText.includes("randomized")) return 0.06;
    }

    if (isPrimarySource) return 0.08;
    if (isSupplementalSource) return 0.04;
    return item.source === "pubmed" ? 0.04 : 0.05;
}

function isHydrationIntent(intent) {
    const intentText = `${intent.intent || ""} ${intent.normalizedMessage || ""}`.toLowerCase();
    return HYDRATION_TERMS.some((term) => intentText.includes(term));
}

function hasHydrationEvidence(evidenceText) {
    const text = String(evidenceText || "").toLowerCase();
    return HYDRATION_TERMS.some((term) => text.includes(term));
}

function clampTierToMax(tier, maxTier) {
    const current = Number(String(tier || "tier4").replace("tier", "")) || 4;
    const maxAllowed = Math.max(1, Math.min(4, Number(maxTier) || 4));
    const clamped = Math.max(current, maxAllowed);
    return `tier${clamped}`;
}

function classifyTier(item, intent, metrics, evidenceText) {
    const hasDiseaseMatch = !intent.disease || metrics.diseaseMatch;
    const requiresIntentFilter = metrics.intentKeywords.length > 0;
    const hardIntentMatch = metrics.intentKeywordMatches > 0;
    const strongChunkMatch = metrics.semanticStrong || metrics.matchedChunkCount > 0;
    const highQuality = metrics.studyTypeWeight >= 0.18 || metrics.recencyBoost >= 0.08;
    const targetedClinicalQuestion = (intent.substances || []).length > 0 || (intent.symptoms || []).length > 0;
    const source = String(item.source || "").toLowerCase();
    const retrievalMode = String(intent.retrievalMode || "").toLowerCase();
    const llmSemantic = item.llmSemantic || {};
    const llmRelevant = llmSemantic.relevant;
    const llmTierSuggestion = Number(llmSemantic.tier_suggestion || 0) || null;
    let maxTierAllowed = 1;

    // Hard disease lock: if a disease is specified and the evidence doesn't match it,
    // never allow it to drive primary/supplemental answer lanes.
    if (intent.disease && !metrics.diseaseMatch) {
        return "tier4";
    }

    if (source === "openalex") {
        if (hasDiseaseMatch && (hardIntentMatch || strongChunkMatch)) {
            return clampTierToMax("tier3", 3);
        }
        return "tier4";
    }

    if (source === "clinicaltrials") maxTierAllowed = Math.max(maxTierAllowed, 2);

    if (isHydrationIntent(intent) && !hasHydrationEvidence(evidenceText)) {
        maxTierAllowed = 3;
    }

    if (llmRelevant === false) {
        maxTierAllowed = 3;
    }

    if (llmTierSuggestion) {
        maxTierAllowed = Math.max(maxTierAllowed, llmTierSuggestion);
    }

    if (retrievalMode === "intervention_landscape" && hasDiseaseMatch) {
        if (source === "clinicaltrials") {
            return clampTierToMax("tier2", maxTierAllowed);
        }
        if (highQuality || strongChunkMatch) {
            return clampTierToMax("tier2", maxTierAllowed);
        }
    }

    if (hasDiseaseMatch && hardIntentMatch && strongChunkMatch && highQuality) {
        const baseTier = source === "clinicaltrials" ? "tier2" : "tier1";
        return clampTierToMax(baseTier, maxTierAllowed);
    }

    if (hasDiseaseMatch && hardIntentMatch && (strongChunkMatch || highQuality)) {
        return clampTierToMax("tier2", maxTierAllowed);
    }

    if (hasDiseaseMatch && (!targetedClinicalQuestion || hardIntentMatch || strongChunkMatch)) {
        return clampTierToMax("tier3", maxTierAllowed);
    }

    return clampTierToMax("tier4", maxTierAllowed);
}

function tierPriority(tier) {
    return {
        tier1: 1,
        tier2: 2,
        tier3: 3,
        tier4: 4
    }[tier] || 4;
}

function scoreEvidence(item, intent) {
    const evidenceText = buildEvidenceText(item);
    const intentKeywords = buildIntentKeywords(intent);
    const diseaseMatch = diseaseMatchesEvidence(intent, evidenceText);
    const symptomMatches = countMatches(evidenceText, intent.symptoms);
    const substanceMatches = countMatches(evidenceText, intent.substances);
    const tokenMatches = countMatches(evidenceText, intent.tokens);
    const intentKeywordMatches = countMatches(evidenceText, intentKeywords);
    const locationMatch = intent.location.tokens.some((token) => evidenceText.includes(token))
        || (item.locations || []).some((country) => intent.location.normalized.toLowerCase().includes(String(country).toLowerCase()));
    const studyTypeWeight = getStudyTypeWeight(item);
    const recencyBoost = item.year >= 2024 ? 0.12 : item.year >= 2021 ? 0.08 : 0.03;
    const matchedChunkCount = (item.matchedSentences || []).length;
    const semanticStrong = Number(item.semanticScore || 0) >= 0.45;
    const semanticBoost = item.semanticScore ? Math.min(item.semanticScore * 0.3, 0.3) : 0;
    const sourceBoost = getSourceSpecificBoost(item, intent);
    const evidenceBoost = (item.evidenceSentences || []).length > 0 ? 0.08 : 0;
    const matchedSentenceBoost = matchedChunkCount > 0 ? Math.min(matchedChunkCount * 0.06, 0.18) : 0;
    const diseaseBoost = diseaseMatch ? 0.32 : 0;
    const hardDiseasePenalty = intent.disease && !diseaseMatch ? 0.35 : 0;
    const symptomBoost = Math.min(symptomMatches * 0.1, 0.2);
    const substanceBoost = Math.min(substanceMatches * 0.1, 0.2);
    const tokenBoost = Math.min(tokenMatches * 0.03, 0.18);
    const intentBoost = Math.min(intentKeywordMatches * 0.07, 0.21);
    const locationBoost = locationMatch ? 0.12 : 0;
    const hardIntentPenalty = intentKeywords.length > 0 && intentKeywordMatches === 0 ? 0.18 : 0;
    const substancePenalty = intent.substances.length > 0 && substanceMatches === 0 ? 0.08 : 0;
    const sourceWeight = SOURCE_WEIGHT[item.source] ?? 0.7;
    const sourceWeightBoost = (sourceWeight - 0.6) * 0.5;
    const llmSemantic = item.llmSemantic || {};
    const llmConfidence = typeof llmSemantic.confidence === "number" ? llmSemantic.confidence : 0;
    const llmRelevanceBoost = llmSemantic.relevant === true ? Math.min(0.12, llmConfidence * 0.12) : 0;
    const llmIrrelevantPenalty = llmSemantic.relevant === false ? 0.1 : 0;

    const metrics = {
        diseaseMatch,
        symptomMatches,
        substanceMatches,
        tokenMatches,
        intentKeywords,
        intentKeywordMatches,
        locationMatch,
        studyTypeWeight,
        recencyBoost,
        matchedChunkCount,
        semanticStrong
    };
    const tier = classifyTier(item, intent, metrics, evidenceText);

    const score = Number((
        diseaseBoost +
        symptomBoost +
        substanceBoost +
        tokenBoost +
        intentBoost +
        locationBoost +
        sourceBoost +
        recencyBoost +
        evidenceBoost +
        matchedSentenceBoost +
        semanticBoost +
        studyTypeWeight -
        hardDiseasePenalty -
        hardIntentPenalty -
        substancePenalty +
        llmRelevanceBoost -
        llmIrrelevantPenalty +
        sourceWeightBoost
    ).toFixed(2));

    return {
        ...item,
        tier,
        tierPriority: tierPriority(tier),
        score,
        rankingSignals: {
            diseaseMatch,
            symptomMatches,
            substanceMatches,
            intentKeywordMatches,
            locationMatch,
            semanticScore: Number(item.semanticScore || 0),
            matchedChunkCount,
            studyTypeWeight,
            sourceWeight,
            llmRelevant: llmSemantic.relevant,
            llmTierSuggestion: llmSemantic.tier_suggestion || null
        }
    };
}

function rankEvidence(evidence, intent) {
    const rankedDocLimit = Number(process.env.RANKED_DOC_K || 40);
    return evidence
        .map((item) => scoreEvidence(item, intent))
        .sort((left, right) => {
            if (left.tierPriority !== right.tierPriority) {
                return left.tierPriority - right.tierPriority;
            }
            return right.score - left.score;
        })
        .slice(0, rankedDocLimit);
}

module.exports = {
    rankEvidence
};
