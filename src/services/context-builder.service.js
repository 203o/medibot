function pickStatement(item) {
    if (item?.matchedSentences?.length) return item.matchedSentences[0];
    if (item?.evidenceSentences?.length) return item.evidenceSentences[0];
    return item?.snippet || item?.title || "";
}

function pickStatementBundle(item) {
    const pool = [];
    if (item?.matchedSentences?.length) {
        pool.push(...item.matchedSentences.slice(0, 2));
    }
    if (item?.evidenceSentences?.length) {
        pool.push(...item.evidenceSentences.slice(0, 2));
    }
    if (!pool.length && item?.snippet) pool.push(item.snippet);
    if (!pool.length && item?.title) pool.push(item.title);
    return pool.filter(Boolean).slice(0, 2).join(" ");
}

function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function compressEvidenceText(text, maxChars = 300) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return "";

    const sentences = normalized
        .split(/(?<=[.!?])\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
    const compact = sentences.slice(0, 2).join(" ");
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, maxChars - 3)}...`;
}

function sourceType(source) {
    if (source === "pubmed") return "pubmed";
    if (source === "clinicaltrials") return "clinical_trial";
    if (source === "openalex") return "openalex";
    return "other";
}

function evidenceStrength(item) {
    if (item.tier === "tier1") return "high";
    if (item.tier === "tier2") return "medium";
    return "low";
}

function detectPolarity(text) {
    const normalized = String(text || "").toLowerCase();
    const negative = ["no significant", "not associated", "insufficient", "unclear", "limited evidence", "did not improve", "no difference"];
    const positive = ["improved", "reduced", "effective", "associated with", "benefit", "supports", "increased"];
    if (negative.some((cue) => normalized.includes(cue))) return "negative";
    if (positive.some((cue) => normalized.includes(cue))) return "positive";
    return "neutral";
}

function computeConflictLevel(primaryEvidence) {
    const polarities = primaryEvidence.map((item) => detectPolarity(item.summary));
    const hasPositive = polarities.includes("positive");
    const hasNegative = polarities.includes("negative");
    if (hasPositive && hasNegative && primaryEvidence.length >= 3) return "strong";
    if (hasPositive && hasNegative) return "mild";
    return "none";
}

function toEvidenceItem(item) {
    return {
        id: item.id,
        title: item.title || "Untitled source",
        summary: compressEvidenceText(pickStatementBundle(item)),
        source_type: sourceType(item.source),
        study_type: item.studyType || "",
        year: item.year || null,
        evidence_strength: evidenceStrength(item),
        score: item.score || 0
    };
}

function dedupeById(items) {
    const seen = new Set();
    const deduped = [];
    for (const item of items) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        deduped.push(item);
    }
    return deduped;
}

function diversifyEvidence(items, maxCount) {
    const pool = dedupeById(items);
    const selected = [];
    const seenTypes = new Set();

    for (const item of pool) {
        const typeKey = `${item.source_type}:${String(item.study_type || "").toLowerCase()}`;
        if (!seenTypes.has(typeKey)) {
            selected.push(item);
            seenTypes.add(typeKey);
            if (selected.length >= maxCount) return selected;
        }
    }
    for (const item of pool) {
        if (selected.find((picked) => picked.id === item.id)) continue;
        selected.push(item);
        if (selected.length >= maxCount) return selected;
    }
    return selected;
}

function buildCitationCatalog(rankedEvidence) {
    const catalog = {};
    for (const item of rankedEvidence || []) {
        if (!item?.id) continue;
        catalog[item.id] = {
            id: item.id,
            title: item.title || "Untitled source",
            source_type: sourceType(item.source),
            platform: item.source || "unknown",
            year: item.year || null,
            url: item.url || ""
        };
    }
    return catalog;
}

function buildChatContext(intent, rankedEvidence, message) {
    const evidencePool = rankedEvidence || [];
    const primaryRaw = evidencePool.filter((item) => item.tier === "tier1").map(toEvidenceItem);
    const tier2Raw = evidencePool.filter((item) => item.tier === "tier2").map(toEvidenceItem);
    const tier3Raw = evidencePool.filter((item) => item.tier === "tier3").map(toEvidenceItem);
    const supplementalRaw = [...tier2Raw];
    let primaryEvidence = diversifyEvidence(primaryRaw, 4);
    let supplementalEvidence = diversifyEvidence(supplementalRaw, 3);
    let usedLowerTierFallback = false;
    const tier3AssistEvidence = diversifyEvidence(
        evidencePool.filter((item) => item.tier === "tier3").map(toEvidenceItem),
        2
    );
    const queryText = String(message || intent.intent || "").toLowerCase();
    const exploratoryQuery = /(animal|wild|wildlife|rare|uncommon|mechanism|landscape|broad research|non clinical)/.test(queryText);

    // Basic robustness: if no tier1 exists but tier2 exists, promote top tier2 into primary.
    if (!primaryEvidence.length && tier2Raw.length) {
        const promoted = diversifyEvidence(tier2Raw, 2);
        primaryEvidence = promoted;
        const promotedIds = new Set(promoted.map((item) => item.id));
        supplementalEvidence = diversifyEvidence(
            tier2Raw.filter((item) => !promotedIds.has(item.id)),
            3
        );
    }

    // Second fallback lane: promote tier3 when tier2 is also empty.
    if (!primaryEvidence.length && !supplementalEvidence.length && tier3Raw.length) {
        const promoted = diversifyEvidence(tier3Raw, 2);
        primaryEvidence = promoted;
        const promotedIds = new Set(promoted.map((item) => item.id));
        supplementalEvidence = diversifyEvidence(
            tier3Raw.filter((item) => !promotedIds.has(item.id)),
            2
        );
        usedLowerTierFallback = true;
    }

    if (!primaryEvidence.length && !supplementalEvidence.length) {
        const lowTierFallback = evidencePool
            .filter((item) => item.tier === "tier3" || item.tier === "tier4")
            .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
            .slice(0, 3)
            .map(toEvidenceItem);
        if (lowTierFallback.length > 0) {
            primaryEvidence = diversifyEvidence(lowTierFallback, 2);
            usedLowerTierFallback = true;
        } else {
            const emergencyFallback = evidencePool.slice(0, 2).map(toEvidenceItem);
            primaryEvidence = diversifyEvidence(emergencyFallback, 2);
            usedLowerTierFallback = emergencyFallback.length > 0;
        }
    }

    const conflictLevel = computeConflictLevel(primaryEvidence);
    const conflictHints = primaryEvidence.slice(0, 3).map((item) => item.summary).filter(Boolean);

    return {
        question: message || intent.normalizedMessage || intent.intent || "",
        disease: intent.disease || "",
        intent: intent.intent || "",
        retrieval_mode: intent.retrievalMode || "",
        primaryEvidence,
        supplementalEvidence,
        tier3AssistEvidence,
        tier3AssistEligible: exploratoryQuery || primaryEvidence.length === 0,
        usedLowerTierFallback,
        citationCatalog: buildCitationCatalog(evidencePool),
        conflictHints,
        conflictLevel
    };
}

module.exports = {
    buildChatContext
};
