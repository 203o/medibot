const { unique } = require("./context.service");

const QUERY_STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with",
    "what", "which", "how", "does", "do", "is", "are", "can", "could", "should", "would",
    "about", "me", "give", "show", "tell", "latest", "new", "current", "between"
]);

function platformLabel(source) {
    if (source === "pubmed") return "PubMed";
    if (source === "clinicaltrials") return "ClinicalTrials.gov";
    if (source === "openalex") return "OpenAlex";
    return "Unknown";
}

function contentTokens(text = "") {
    return String(text || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2 && !QUERY_STOPWORDS.has(token));
}

function detectAnswerBasis(intent, answerEvidence = []) {
    // If we have any answer-grounding evidence, treat the response as evidence-based.
    // Lexical overlap alone is too brittle for broad review-style questions.
    return (answerEvidence || []).length > 0 ? "evidence" : "general_knowledge";
}

function buildEvidenceSummary(intent, rankedEvidence) {
    const summarizedEvidence = filterEvidenceForSummary(intent, rankedEvidence);
    const requestedLimit = Number(process.env.SURFACED_EVIDENCE_K || 8);
    const surfacedLimit = Math.min(8, Math.max(6, requestedLimit));
    return summarizedEvidence.slice(0, surfacedLimit).map((item) => ({
        id: item.id,
        source: item.source,
        platform: platformLabel(item.source),
        title: item.title,
        authors: item.authors || [],
        year: item.year,
        studyType: item.studyType,
        tier: item.tier,
        score: item.score,
        url: item.url,
        snippet: item.snippet,
        evidenceSentences: item.evidenceSentences || [],
        matchedSentences: item.matchedSentences || [],
        llmSemantic: item.llmSemantic
            ? {
                relevant: item.llmSemantic.relevant,
                tier_suggestion: item.llmSemantic.tier_suggestion,
                doc_type: item.llmSemantic.doc_type || "",
                focus: item.llmSemantic.focus || "",
                confidence: item.llmSemantic.confidence,
                reason: item.llmSemantic.reason || ""
            }
            : null
    }));
}

function buildSourcePolicy(intent) {
    return {
        primary: "pubmed",
        supplemental: "clinicaltrials",
        exploratory: "openalex",
        ...(intent.sourcePolicy || {})
    };
}

function pickEvidenceStatement(item) {
    if (item.matchedSentences && item.matchedSentences.length) {
        return item.matchedSentences[0];
    }
    if (item.evidenceSentences && item.evidenceSentences.length) {
        return item.evidenceSentences[0];
    }
    return item.snippet || item.title;
}

function buildSourceAttribution(item) {
    return {
        id: item.id,
        title: item.title || "Untitled source",
        authors: item.authors || [],
        year: item.year || null,
        platform: platformLabel(item.source),
        url: item.url || "",
        supportingSnippet: pickEvidenceStatement(item)
    };
}

function groupByTier(rankedEvidence) {
    return rankedEvidence.reduce((accumulator, item) => {
        const tier = item.tier || "tier4";
        if (!accumulator[tier]) {
            accumulator[tier] = [];
        }
        accumulator[tier].push(item);
        return accumulator;
    }, { tier1: [], tier2: [], tier3: [], tier4: [] });
}

function filterBySource(items, source) {
    return (items || []).filter((item) => item.source === source);
}

function detectClaimPolarity(statement) {
    const normalized = String(statement || "").toLowerCase();
    const negativeCues = ["no significant", "not associated", "insufficient", "unclear", "limited evidence", "did not improve", "no difference"];
    const positiveCues = ["improved", "reduced", "effective", "associated with", "benefit", "supports", "increased"];

    if (negativeCues.some((cue) => normalized.includes(cue))) {
        return "negative";
    }
    if (positiveCues.some((cue) => normalized.includes(cue))) {
        return "positive";
    }
    return "neutral";
}

function detectConflict(items) {
    const polarities = items.map((item) => detectClaimPolarity(pickEvidenceStatement(item)));
    return polarities.includes("positive") && polarities.includes("negative");
}

function collectEvidenceText(items = []) {
    return items
        .map((item) => [
            item.title,
            item.snippet,
            item.studyType,
            ...(item.matchedSentences || []),
            ...(item.evidenceSentences || [])
        ].filter(Boolean).join(" "))
        .join(" ")
        .toLowerCase();
}

const EVIDENCE_THEME_PATTERNS = [
    {
        label: "targeted therapy",
        patterns: [/\btargeted therapy\b/i, /\begfr\b/i, /\balk\b/i, /\bros1\b/i, /\bbiomarker\b/i, /\bmutation\b/i]
    },
    {
        label: "immunotherapy",
        patterns: [/\bimmunotherapy\b/i, /\bcheckpoint\b/i, /\bpd-?l1\b/i, /\bpembrolizumab\b/i, /\bnivolumab\b/i, /\batezolizumab\b/i, /\bcemiplimab\b/i]
    },
    {
        label: "chemotherapy combinations",
        patterns: [/\bchemotherapy\b/i, /\bdocetaxel\b/i, /\bcarboplatin\b/i, /\bpaclitaxel\b/i, /\bramucirumab\b/i]
    },
    {
        label: "radiation-based approaches",
        patterns: [/\bradiation\b/i, /\bradiotherapy\b/i, /\bchemoradiation\b/i]
    },
    {
        label: "surgery or perioperative strategies",
        patterns: [/\bsurgery\b/i, /\bsurgical\b/i, /\bneoadjuvant\b/i, /\badjuvant\b/i, /\bresection\b/i]
    },
    {
        label: "clinical trials",
        patterns: [/\bclinical trial\b/i, /\btrial\b/i, /\bphase\s+[ivx]+\b/i, /\bNCT\d+\b/i, /\brecruiting\b/i, /\bongoing\b/i]
    }
];

function extractEvidenceThemes(items = []) {
    const text = collectEvidenceText(items);
    const themes = [];
    for (const theme of EVIDENCE_THEME_PATTERNS) {
        if (theme.patterns.some((pattern) => pattern.test(text)) && !themes.includes(theme.label)) {
            themes.push(theme.label);
        }
        if (themes.length >= 3) break;
    }
    return themes;
}

function formatThemeList(themes = []) {
    const items = (themes || []).filter(Boolean);
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function buildPlainLanguageLead(intent, answerEvidence, supplementalEvidence = []) {
    const queryText = String(intent?.normalizedMessage || intent?.intent || "").toLowerCase();
    const diseaseLabel = resolveCaseConditionLabel(intent, answerEvidence);
    const combinedEvidence = [...(answerEvidence || []), ...(supplementalEvidence || [])];
    const themes = extractEvidenceThemes(combinedEvidence);
    const hasTrials = combinedEvidence.some((item) => item.source === "clinicaltrials");
    const treatmentQuestion = /(treatment|therapy|intervention|management|care)/.test(queryText) || intent?.retrievalMode === "clinical_guidance";
    const latestQuestion = /(latest|current|newest|recent)/.test(queryText);
    const cancerLike = /cancer|oncology|tumou?r|carcinoma|nsclc/i.test(`${diseaseLabel} ${queryText}`);
    const sentences = [];

    if (treatmentQuestion || latestQuestion) {
        sentences.push("In plain language, the evidence points to several treatment directions rather than one universal latest treatment.");
    } else {
        sentences.push("In plain language, the evidence points to a pattern of findings rather than a single paper-level conclusion.");
    }

    if (themes.length) {
        sentences.push(`The main directions showing up are ${formatThemeList(themes)}.`);
    } else {
        sentences.push("The retrieved studies are useful for the big picture, but they do not collapse into one simple headline answer.");
    }

    if (cancerLike) {
        sentences.push("For cancer, the best option usually depends on subtype, stage, biomarkers, and prior treatment.");
    }

    if (hasTrials) {
        sentences.push("Some of the newest options are still being tested in clinical trials, so the answer is still evolving.");
    }

    return sentences.join(" ");
}

function buildGroundedClaims(primaryEvidence, supportingEvidence) {
    const primaryClaims = primaryEvidence.slice(0, 2).map((item, index) => {
        const studyLabel = item.studyType ? ` (${item.studyType})` : "";
        return `${index === 0 ? "Key supporting source" : "Additional supporting source"}${studyLabel}: ${pickEvidenceStatement(item)}`;
    });
    const supportingClaims = supportingEvidence.slice(0, 1).map((item) => {
        const studyLabel = item.studyType ? ` (${item.studyType})` : "";
        return `Supplemental source${studyLabel}: ${pickEvidenceStatement(item)}`;
    });
    return [...primaryClaims, ...supportingClaims];
}

function selectLaneEvidence(rankedEvidence, sourcePolicy) {
    const tiered = groupByTier(rankedEvidence);
    const highSignal = [...tiered.tier1, ...tiered.tier2];
    const primaryLane = filterBySource(highSignal, sourcePolicy.primary).slice(0, 2);
    const supplementalLane = filterBySource(highSignal, sourcePolicy.supplemental).slice(0, 2);
    const exploratorySignal = [...tiered.tier2, ...tiered.tier3];
    const exploratoryLane = filterBySource(exploratorySignal, sourcePolicy.exploratory).slice(0, 2);

    return {
        tiered,
        primaryLane: primaryLane.length > 0 ? primaryLane : highSignal.slice(0, 2),
        supplementalLane,
        exploratoryLane
    };
}

function buildSupplement(intent, supplementalEvidence) {
    if (!supplementalEvidence.length) {
        return "";
    }

    const supplementalSource = supplementalEvidence[0].source;
    const sourceLabel = supplementalSource === "clinicaltrials"
        ? "A related clinical trial signal suggests"
        : "Published background evidence suggests";

    const statements = supplementalEvidence.slice(0, 2).map((item) => pickEvidenceStatement(item)).join(" ");
    const caution = supplementalSource === "clinicaltrials" && (intent.retrievalMode === "ongoing_studies" || intent.retrievalMode === "intervention_landscape")
        ? " Trial summaries may describe active investigations rather than established benefit."
        : "";

    return `${sourceLabel}: ${statements}${caution}`.trim();
}

function parseCaseAnchorsFromIntent(intent = {}) {
    const text = String(intent?.intent || "").toLowerCase();
    const stageMatch = text.match(/\bstage\s+([ivx]+[a-c]?|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?[a-c]?)\b/i);
    const stageRaw = stageMatch ? String(stageMatch[1]) : "";
    const stage = stageRaw && /^[ivx]/i.test(stageRaw)
        ? `stage ${stageRaw.toUpperCase()}`
        : (stageRaw ? `stage ${stageRaw}` : "");
    const pdl1Match = text.match(/pd[-\s]?l1[^0-9]*(\d{1,3})\s*%/i);
    return {
        stage,
        pdl1: pdl1Match ? `PD-L1 ${pdl1Match[1]}%` : "",
        postCrt: /post chemoradiation|post[-\s]?crt/.test(text),
        postDurvalumab: /post durvalumab/.test(text),
        surveillance: /surveillance/.test(text)
    };
}

function resolveCaseConditionLabel(intent = {}, rankedEvidence = []) {
    const explicitDisease = String(intent?.disease || "").trim();
    if (explicitDisease) return explicitDisease;

    const text = String(intent?.intent || "").toLowerCase();
    const known = [
        "parkinson's disease",
        "parkinsons disease",
        "non-small cell lung cancer",
        "lung cancer",
        "hiv",
        "malaria",
        "diabetes"
    ];
    const match = known.find((item) => text.includes(item));
    if (match) return match === "parkinsons disease" ? "Parkinson's disease" : match;

    const firstTitle = String(rankedEvidence?.[0]?.title || "").toLowerCase();
    if (firstTitle.includes("parkinson")) return "Parkinson's disease";
    if (firstTitle.includes("lung cancer") || firstTitle.includes("nsclc")) return "non-small cell lung cancer";
    return "this condition";
}

function normalizeCaseDisease(value = "") {
    return String(value || "")
        .toLowerCase()
        .replace(/[’]/g, "'")
        .replace(/\bnon[-\s]*small[-\s]*cell lung cancer\b/g, "lung cancer")
        .replace(/\bsmall[-\s]*cell lung cancer\b/g, "lung cancer")
        .replace(/\bnsclc\b/g, "lung cancer")
        .replace(/\bparkinson(?:'s|s)?\s+disease\b/g, "parkinson disease")
        .replace(/\bparkinson(?:'s|s)?\b(?!\s+disease)/g, "parkinson disease")
        .replace(/\s+/g, " ")
        .trim();
}

function evidenceMatchesCaseDisease(intent = {}, item = {}) {
    const disease = normalizeCaseDisease(intent?.disease || "");
    if (!disease) return true;

    const evidenceText = normalizeCaseDisease([
        item.title || "",
        item.snippet || "",
        ...(item.matchedSentences || []),
        ...(item.evidenceSentences || [])
    ].join(" "));
    if (!evidenceText) return false;
    if (evidenceText.includes(disease)) return true;

    const diseaseTokens = disease.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    if (!diseaseTokens.length) return true;

    const overlap = diseaseTokens.filter((token) => evidenceText.includes(token)).length;
    const required = diseaseTokens.length >= 3 ? 2 : diseaseTokens.length;
    return overlap >= required;
}

function filterEvidenceForSummary(intent = {}, rankedEvidence = []) {
    const disease = normalizeCaseDisease(intent?.disease || "");
    if (!disease) return rankedEvidence || [];
    const aligned = (rankedEvidence || []).filter((item) => evidenceMatchesCaseDisease(intent, item));
    return aligned.length > 0 ? aligned : [];
}

function buildCaseResearchAnswer(intent, rankedEvidence = []) {
    const anchors = parseCaseAnchorsFromIntent(intent);
    const conditionLabel = resolveCaseConditionLabel(intent, rankedEvidence);
    const diseaseAlignedEvidence = filterEvidenceForSummary(intent, rankedEvidence);
    const evidencePool = diseaseAlignedEvidence.slice(0, 7);
    const top = evidencePool.slice(0, 5);
    const citations = [...new Set(top.map((item) => item.id).filter(Boolean))];
    const anchorParts = [
        anchors.stage,
        anchors.pdl1,
        anchors.postCrt ? "post-chemoradiation" : "",
        anchors.postDurvalumab ? "post-durvalumab" : "",
        anchors.surveillance ? "surveillance phase" : ""
    ].filter(Boolean);
    const anchorLine = anchorParts.length
        ? `Case anchors used: ${anchorParts.join(", ")}.`
        : "";
    if (!top.length) {
        return [
            `Research discovery summary: The current retrieval did not surface clearly case-matched evidence for ${conditionLabel}.`,
            anchorLine,
            "Research landscape:",
            "- The available studies in this turn are broad background evidence rather than a clean match to the case.",
            "Evidence gaps and uncertainty:",
            `- Directly case-matched evidence for ${conditionLabel} remains limited across the retrieved set.`,
            "- Study populations and endpoints vary, so transportability to this exact profile is uncertain.",
            "This is a research-focused summary, not clinical advice."
        ]
            .filter(Boolean)
            .join("\n")
            .trim();
    }

    const evidenceOverview = top
        .map((item) => `- ${item.title || "Untitled source"} [${item.id}]`)
        .join("\n");
    const spotlight = top[0];
    const spotlightParts = [
        spotlight?.id ? `- ID: ${spotlight.id}` : "",
        spotlight?.title ? `- Title: ${spotlight.title}` : "",
        spotlight?.studyType ? `- Type: ${spotlight.studyType}` : "",
        spotlight?.year ? `- Year: ${spotlight.year}` : ""
    ].filter(Boolean).join("\n");
    const hasTrials = top.some((item) => item.source === "clinicaltrials");
    const hasPub = top.some((item) => item.source === "pubmed");
    const relevanceBullets = [
        anchors.stage ? `- Stage alignment: evidence includes ${anchors.stage} or closely related disease settings.` : "",
        anchors.pdl1 ? `- Biomarker alignment: evidence reflects biomarker-aware strategies (${anchors.pdl1}).` : "",
        anchors.postDurvalumab || anchors.postCrt
            ? `- Prior-therapy alignment: evidence is interpreted in a ${[anchors.postCrt ? "post-chemoradiation" : "", anchors.postDurvalumab ? "post-durvalumab" : ""].filter(Boolean).join(" + ")} context.`
            : "",
        anchors.surveillance ? "- Current-phase alignment: surveillance-phase implications were prioritized in ranking." : "",
        hasTrials ? "- Ongoing-study signal: clinical trial registry evidence is available for forward-looking options." : "",
        hasPub ? "- Published-evidence signal: peer-reviewed literature anchors the main interpretation." : ""
    ].filter(Boolean).slice(0, 4).join("\n");
    const gaps = [
        `- Directly case-matched evidence for ${conditionLabel} remains limited across the retrieved set.`,
        "- Study populations and endpoints vary, so transportability to this exact profile is uncertain.",
        hasTrials ? "- Several findings are investigational and should be interpreted as research direction, not confirmed standard-of-care." : ""
    ].filter(Boolean).join("\n");

    return [
        `Research discovery summary: Retrieved evidence for this patient profile points to active treatment-strategy research in ${conditionLabel}, with case-matched applicability depending on disease stage and clinical setting.`,
        anchorLine,
        "Research landscape:",
        evidenceOverview,
        "Study spotlight:",
        spotlightParts,
        "Why relevant to this patient:",
        relevanceBullets,
        "Evidence gaps and uncertainty:",
        gaps,
        "This is a research-focused summary, not clinical advice.",
        citations.length ? `Citations: ${citations.map((id) => `[${id}]`).join(" ")}` : ""
    ]
        .filter(Boolean)
        .join("\n")
        .trim();
}

function buildAnswer(intent, rankedEvidence, previousMemory, llmSynthesis = null, options = {}) {
    const sourcePolicy = buildSourcePolicy(intent);
    const { tiered: byTier, primaryLane, supplementalLane, exploratoryLane } = selectLaneEvidence(rankedEvidence, sourcePolicy);
    const primaryAnswerEvidence = [...primaryLane.slice(0, 2)];
    const answerEvidence = primaryAnswerEvidence.length > 0
        ? primaryAnswerEvidence
        : [...(rankedEvidence || []).slice(0, 2)];
    const usedFallbackEvidence = primaryAnswerEvidence.length === 0 && answerEvidence.length > 0;
    const supplementText = buildSupplement(intent, supplementalLane.slice(0, 1));
    const evidenceIds = answerEvidence.map((item) => item.id);
    const supplementalMappings = supplementalLane.slice(0, 1).map((item, index) => ({
        claimId: `supplement_${index + 1}`,
        lane: "supplemental",
        tier: item.tier,
        statement: pickEvidenceStatement(item),
        sources: [buildSourceAttribution(item)]
    }));
    const exploratoryMappings = exploratoryLane.slice(0, 1).map((item, index) => ({
        claimId: `explore_${index + 1}`,
        lane: "exploratory",
        tier: item.tier,
        statement: pickEvidenceStatement(item),
        sources: [buildSourceAttribution(item)]
    }));
    const sourceMapping = answerEvidence.map((item, index) => ({
        claimId: `claim_${index + 1}`,
        lane: "primary",
        tier: item.tier,
        statement: pickEvidenceStatement(item),
        sources: [buildSourceAttribution(item)]
    }));

    let answer = "The available evidence is limited for this request.";
    const llmAnswer = llmSynthesis?.enabled && llmSynthesis.answer
        ? String(llmSynthesis.answer || "").trim()
        : "";
    if (answerEvidence.length > 0) {
        const opener = intent.retrievalMode === "ongoing_studies"
            ? `For ${intent.disease || "this topic"}, here is what the current studies are pointing to:`
            : intent.retrievalMode === "intervention_landscape"
                ? `For ${intent.disease || "this topic"}, here is the treatment landscape:`
                : intent.disease
                    ? `For ${intent.disease}, here is the practical takeaway:`
                    : "Here is the practical takeaway:";
        const plainLanguageLead = buildPlainLanguageLead(intent, answerEvidence, supplementalLane);
        const locationLine = intent.location.normalized
            ? `Location context used: ${intent.location.normalized}.`
            : "";
        const previousLine = previousMemory.lastAnswerSummary
            ? "This answer also preserves the previous validated context."
            : "";
        const conflictLine = detectConflict(answerEvidence)
            ? "The available top-tier evidence is mixed, so the answer should be interpreted cautiously."
            : "";
        const claimLines = buildGroundedClaims(answerEvidence, []).map((line) => `- ${line}`).join("\n");
        const deterministicSections = [
            `${opener} ${plainLanguageLead}`.trim(),
            locationLine,
            previousLine,
            conflictLine,
            claimLines ? `Supporting evidence:\n${claimLines}` : "",
            supplementText ? `Additional context: ${supplementText}` : ""
        ].filter(Boolean);
        const deterministicAnswer = deterministicSections.join("\n").trim();
        if (llmAnswer) {
            const hasCaution = /evidence is partial;?\s*interpret cautiously|evidence is partial and should be interpreted cautiously/i.test(llmAnswer);
            answer = llmSynthesis.synthesisTier === "B" && !hasCaution
                ? `${llmAnswer} Evidence is partial and should be interpreted cautiously.`
                : llmAnswer;
        } else {
            answer = options.caseMode
                ? buildCaseResearchAnswer(intent, rankedEvidence) || deterministicAnswer
                : deterministicAnswer;
        }
    }

    answer = String(answer || "").replace(
        /(Evidence is partial;?\s*interpret cautiously\.?\s*){2,}/gi,
        "Evidence is partial; interpret cautiously. "
    ).trim();

    const caseMode = !!options.caseMode;
    if (caseMode && !llmAnswer) {
        const caseAnswer = buildCaseResearchAnswer(intent, rankedEvidence);
        if (caseAnswer) {
            answer = caseAnswer;
        }
    }

    const answerBasis = detectAnswerBasis(intent, answerEvidence);
    if (answerBasis === "general_knowledge" && !/general knowledge/i.test(answer)) {
        answer = `General knowledge note: This answer includes general medical knowledge and is not directly supported by retrieved evidence for this exact question. ${answer}`.trim();
    }

    const insights = [];
    if (intent.location.normalized) {
        insights.push(`Location context supplied: ${intent.location.normalized}. Evidence may still be global if no region-specific study was retrieved.`);
    }
    if (detectConflict(answerEvidence)) {
        insights.push("Top-ranked chunks are not fully aligned; some retrieved evidence suggests mixed or uncertain findings.");
    }
    if (llmSynthesis?.enabled && llmSynthesis.evidence_mixed) {
        insights.push("LLM conflict summary: evidence is mixed across top-tier sources.");
        if (llmSynthesis.conflict_reason) {
            insights.push(`Conflict reason: ${llmSynthesis.conflict_reason}`);
        }
        if (Array.isArray(llmSynthesis.conflict_details) && llmSynthesis.conflict_details.length) {
            insights.push(`Conflict details: ${llmSynthesis.conflict_details.join(" | ")}`);
        }
    }
    if (supplementalLane.length > 0) {
        insights.push(`Supplemental ${sourcePolicy.supplemental} evidence was added separately from the primary lane.`);
    }
    if (exploratoryLane.length > 0) {
        insights.push(`Exploratory ${sourcePolicy.exploratory} evidence was captured for landscape depth but not used as primary treatment evidence.`);
    }
    if (byTier.tier3.length > 0 || byTier.tier4.length > 0) {
        insights.push(`Lower-tier evidence was excluded from the main answer: tier3=${byTier.tier3.length}, tier4=${byTier.tier4.length}.`);
    }
    if (intent.riskFlags.length > 0) {
        insights.push(`Risk flags detected: ${intent.riskFlags.join(", ")}.`);
    }
    if (previousMemory.lastEvidenceIds?.length) {
        insights.push(`Previous validated evidence IDs in session: ${previousMemory.lastEvidenceIds.join(", ")}.`);
    }
    if (usedFallbackEvidence) {
        insights.push("Primary answer lane was empty; top-ranked fallback evidence was used instead.");
    }
    if (caseMode && llmAnswer) {
        insights.push("Case narrative detected; LLM synthesis was used as the main answer and the case snapshot stayed in the evidence lanes.");
    }

    const llmReason = String(llmSynthesis?.reason || "");
    const synthesisWeak = llmReason.includes("insufficient")
        || llmReason.includes("no_")
        || llmReason.includes("strict");
    const confidence = synthesisWeak
        ? "low"
        : (byTier.tier1.length >= 2 ? "high" : answerEvidence.length >= 2 ? "medium" : "low");

    const validation = {
        isValid: answerEvidence.length > 0,
        confidence,
        checks: [
            {
                name: "Tiered evidence retrieved",
                status: answerEvidence.length > 0 ? (usedFallbackEvidence ? "warn" : "pass") : "fail",
                detail: answerEvidence.length > 0
                    ? (usedFallbackEvidence
                        ? "No tier1 or tier2 evidence was available, so the answer used the top-ranked fallback evidence."
                        : `Main answer grounded in ${sourcePolicy.primary} ${byTier.tier1.length > 0 ? "tier1" : "tier2"} evidence.`)
                    : "No answer-grounding evidence could be selected."
            },
            {
                name: "Source mapping",
                status: sourceMapping.length > 0 ? "pass" : "fail",
                detail: sourceMapping.length > 0 ? "Every surfaced claim maps to an external source." : "No mapped sources available."
            },
            {
                name: "Chunk grounding",
                status: answerEvidence.some((item) => (item.matchedSentences || []).length > 0 || (item.evidenceSentences || []).length > 0) ? "pass" : "warn",
                detail: answerEvidence.some((item) => (item.matchedSentences || []).length > 0)
                    ? "Answer uses semantically matched abstract or trial-summary chunks."
                    : answerEvidence.some((item) => (item.evidenceSentences || []).length > 0)
                        ? "Answer uses extracted abstract or trial-summary sentences."
                        : "No extracted chunks were available, so fallback snippets were used."
            },
            {
                name: "Conflict check",
                status: (detectConflict(answerEvidence) || (llmSynthesis?.enabled && llmSynthesis.evidence_mixed)) ? "warn" : "pass",
                detail: (detectConflict(answerEvidence) || (llmSynthesis?.enabled && llmSynthesis.evidence_mixed))
                    ? "Top-ranked chunks contain mixed signals."
                    : "No direct conflict detected across top-ranked chunks."
            },
            {
                name: "Claim citation validation",
                status: llmSynthesis?.enabled
                    ? ((llmSynthesis.claims || []).length > 0 ? "pass" : "warn")
                    : "pass",
                detail: llmSynthesis?.enabled
                    ? ((llmSynthesis.claims || []).length > 0
                        ? "All retained LLM claims include valid citations."
                        : "LLM synthesis returned no citation-valid claims; deterministic grounding was used or retained.")
                    : "Deterministic claim grounding used."
            },
            {
                name: "Dual-lane synthesis",
                status: supplementalLane.length > 0 ? "pass" : "warn",
                detail: supplementalLane.length > 0
                    ? `Supplemental ${sourcePolicy.supplemental} evidence was kept separate from the primary lane.`
                    : `No supplemental ${sourcePolicy.supplemental} evidence was added.`
            },
            {
                name: "Exploratory evidence lane",
                status: exploratoryLane.length > 0 ? "pass" : "warn",
                detail: exploratoryLane.length > 0
                    ? `Exploratory ${sourcePolicy.exploratory} evidence was isolated from treatment-driving claims.`
                    : `No exploratory ${sourcePolicy.exploratory} evidence was included.`
            }
        ]
    };

    return {
        answer,
        answerBasis,
        supplement: supplementText,
        insights,
        evidenceIds,
        sourceMapping: [...sourceMapping, ...supplementalMappings, ...exploratoryMappings],
        validation,
        tierBreakdown: {
            tier1: byTier.tier1.length,
            tier2: byTier.tier2.length,
            tier3: byTier.tier3.length,
            tier4: byTier.tier4.length
        },
        lanes: {
            primarySource: sourcePolicy.primary,
            supplementalSource: sourcePolicy.supplemental,
            exploratorySource: sourcePolicy.exploratory,
            primaryEvidence: primaryLane.map((item) => item.id),
            supplementalEvidence: supplementalLane.map((item) => item.id),
            exploratoryEvidence: exploratoryLane.map((item) => item.id)
        }
    };
}

function compactRetrievedEvidence(rankedEvidence = []) {
    return (rankedEvidence || []).slice(0, 30).map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title || "",
        snippet: pickEvidenceStatement(item),
        evidenceSentences: (item.evidenceSentences || []).slice(0, 2),
        matchedSentences: (item.matchedSentences || []).slice(0, 2),
        authors: item.authors || [],
        year: item.year || null,
        studyType: item.studyType || "",
        tier: item.tier || "tier4",
        score: Number(item.score || 0),
        url: item.url || ""
    }));
}

function buildUpdatedMemory(previousMemory, intent, answerPayload, rankedEvidence = []) {
    const intentText = String(intent.intent || "").toLowerCase();
    let lastAnswerFocus = "other";
    if (/prevalence|incidence|rate|epidemiology/.test(intentText)) {
        lastAnswerFocus = "prevalence";
    } else if (intent.retrievalMode === "intervention_landscape" || /intervention|therapy|stimulation|procedure/.test(intentText)) {
        lastAnswerFocus = "intervention";
    } else if (/treatment|manage|guidance|care/.test(intentText) || intent.retrievalMode === "clinical_guidance") {
        lastAnswerFocus = "treatment";
    }

    return {
        sessionId: previousMemory.sessionId,
        conditions: unique([...(previousMemory.conditions || []), ...intent.conditions]),
        intents: unique([...(previousMemory.intents || []), intent.intent]),
        symptoms: unique([...(previousMemory.symptoms || []), ...intent.symptoms]),
        substances: unique([...(previousMemory.substances || []), ...intent.substances]),
        riskFlags: unique([...(previousMemory.riskFlags || []), ...intent.riskFlags]),
        location: intent.location.normalized ? intent.location : (previousMemory.location || intent.location),
        lastAnswerSummary: answerPayload.answer,
        lastEvidenceIds: answerPayload.evidenceIds,
        lastRetrievedIds: unique([...(answerPayload.evidenceIds || []), ...((answerPayload.lanes?.supplementalEvidence) || []), ...((answerPayload.lanes?.exploratoryEvidence) || [])]),
        lastRetrievedEvidence: compactRetrievedEvidence(rankedEvidence),
        lastAnswerFocus,
        lastQueryFacets: {
            disease: intent.disease || "",
            location: intent.location?.normalized || "",
            retrievalMode: intent.retrievalMode || "",
            substances: intent.substances || [],
            symptoms: intent.symptoms || []
        }
    };
}

function buildFinalResponse({ sessionId, message, intent, rankedEvidence, previousMemory, retrievalMeta }) {
    const answerPayload = buildAnswer(
        intent,
        rankedEvidence,
        previousMemory,
        retrievalMeta.llmSynthesis || null,
        { caseMode: !!retrievalMeta.caseMode }
    );
    const updatedMemory = buildUpdatedMemory(previousMemory, intent, answerPayload, rankedEvidence);
    const retrievalPolicy = {
        sourceWeights: {
            pubmed: 1.0,
            clinicaltrials: 0.8,
            openalex: 0.6
        },
        sourceRoles: {
            pubmed: "primaryEvidence",
            clinicaltrials: "supplementalEvidence",
            openalex: "exploratoryEvidence"
        },
        trustRules: [
            "Use PubMed as primary evidence for clinical guidance and treatment decisions.",
            "Use ClinicalTrials as emerging supplemental evidence.",
            "Use OpenAlex only for exploratory context and gap filling.",
            "Do not use exploratory evidence as the sole basis for treatment recommendations."
        ]
    };

    return {
        sessionId,
        query: message,
        medicalContext: {
            disease: intent.disease,
            intent: intent.intent,
            location: intent.location.normalized,
            retrievalMode: intent.retrievalMode
        },
        answer: answerPayload.answer,
        answerBasis: answerPayload.answerBasis || "evidence",
        supplement: answerPayload.supplement,
        insights: answerPayload.insights,
        confidence: answerPayload.validation.confidence,
        evidence: buildEvidenceSummary(intent, rankedEvidence),
        retrieval: {
            mode: intent.retrievalMode,
            autofill: retrievalMeta.autofill || null,
            routeConfidence: intent.routeConfidence,
            routeReasoning: intent.routeReasoning,
            intentRouting: {
                finalMode: intent.retrievalMode,
                embeddingMode: intent.routeEmbeddingMode || "",
                decisionSource: intent.routeDecisionSource || "embedding",
                confidence: intent.routeConfidence,
                reasoning: intent.routeReasoning,
                scores: intent.routeScores || {},
                llmRefinement: intent.routeLlmRefinement || {}
            },
            source: retrievalMeta.source || "unknown",
            ingestionRunId: retrievalMeta.ingestionRunId || "",
            ingestionOutputDir: retrievalMeta.ingestionOutputDir || "",
            publicationsCount: retrievalMeta.publicationsCount,
            pubmedCount: retrievalMeta.pubmedCount || retrievalMeta.publicationsCount,
            openalexCount: retrievalMeta.openalexCount || 0,
            trialsCount: retrievalMeta.trialsCount,
            queryPlan: retrievalMeta.queryPlan || null,
            llmSynthesis: retrievalMeta.llmSynthesis
                ? {
                    enabled: !!retrievalMeta.llmSynthesis.enabled,
                    reason: retrievalMeta.llmSynthesis.reason || "",
                    synthesisTier: retrievalMeta.llmSynthesis.synthesisTier || "",
                    evidenceMixed: !!retrievalMeta.llmSynthesis.evidence_mixed,
                    citationsCount: (retrievalMeta.llmSynthesis.citations || []).length,
                    claimsCount: (retrievalMeta.llmSynthesis.claims || []).length
                }
                : null,
            followup: retrievalMeta.followup || null,
            contextBuilder: retrievalMeta.chatContext
                ? {
                    primaryCount: (retrievalMeta.chatContext.primaryEvidence || []).length,
                    supplementalCount: (retrievalMeta.chatContext.supplementalEvidence || []).length,
                    usedLowerTierFallback: !!retrievalMeta.chatContext.usedLowerTierFallback,
                    conflictLevel: retrievalMeta.chatContext.conflictLevel || "none"
                }
                : null,
            rankedCount: rankedEvidence.length,
            tierBreakdown: answerPayload.tierBreakdown,
            sourcePolicy: answerPayload.lanes,
            policy: retrievalPolicy,
            stages: [
                {
                    label: "PubMed publications",
                    matches: retrievalMeta.pubmedCount || retrievalMeta.publicationsCount,
                    rule: "PubMed search using disease, intent, symptoms, and optional location."
                },
                {
                    label: "OpenAlex publications",
                    matches: retrievalMeta.openalexCount || 0,
                    rule: "OpenAlex works search for broad publication recall with title, abstract/summary, authors, year, and URL."
                },
                {
                    label: "Clinical trials",
                    matches: retrievalMeta.trialsCount,
                    rule: "ClinicalTrials.gov search using disease, intent, symptoms, and optional location."
                },
                {
                    label: "Tiered ranking",
                    matches: rankedEvidence.length,
                    rule: "Evidence is classified into tier1-tier4 using hard intent filters, semantic chunk match, study type, recency, and geography."
                },
                {
                    label: "Dual-lane answer",
                    matches: answerPayload.lanes.primaryEvidence.length + answerPayload.lanes.supplementalEvidence.length,
                    rule: "Primary and supplemental evidence lanes are separated so ongoing trials do not get blended with established evidence."
                },
                {
                    label: "Exploratory lane",
                    matches: answerPayload.lanes.exploratoryEvidence.length,
                    rule: "OpenAlex evidence is stored as exploratory context and is excluded from treatment-driving claims."
                }
            ]
        },
        sourceMapping: answerPayload.sourceMapping,
        validation: answerPayload.validation,
        memory: {
            conditions: updatedMemory.conditions,
            intents: updatedMemory.intents,
            symptoms: updatedMemory.symptoms,
            substances: updatedMemory.substances,
            riskFlags: updatedMemory.riskFlags,
            location: updatedMemory.location,
            previousEvidenceIds: updatedMemory.lastEvidenceIds,
            lastRetrievedIds: updatedMemory.lastRetrievedIds,
            lastRetrievedEvidenceCount: (updatedMemory.lastRetrievedEvidence || []).length,
            lastAnswerFocus: updatedMemory.lastAnswerFocus,
            lastQueryFacets: updatedMemory.lastQueryFacets
        },
        conversation: {
            grounded: true,
            previousAnswerSummary: previousMemory.lastAnswerSummary || "",
            retrievalMode: intent.retrievalMode,
            retrievalPolicy
        }
    };
}

module.exports = {
    buildFinalResponse
};
