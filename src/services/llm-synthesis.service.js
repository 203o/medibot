function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function flattenClaimCitations(claims) {
    const citations = [];
    for (const claim of claims || []) {
        for (const citation of claim.citations || []) {
            if (!citations.includes(citation)) citations.push(citation);
        }
    }
    return citations;
}

function trimText(value, maxChars) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function trimContext(context, strict, aggressive = false) {
    const primaryMax = aggressive ? 1 : (strict ? 2 : Number(process.env.LLM_SYNTH_PRIMARY_MAX || 3));
    const supplementalMax = aggressive ? 1 : (strict ? 1 : Number(process.env.LLM_SYNTH_SUPPLEMENTAL_MAX || 2));
    const titleChars = aggressive ? 90 : 120;
    const summaryChars = aggressive ? 140 : 220;

    const primaryEvidence = (context.primaryEvidence || []).slice(0, primaryMax).map((item) => ({
        ...item,
        title: trimText(item.title, titleChars),
        summary: trimText(item.summary, summaryChars)
    }));
    const supplementalEvidence = (context.supplementalEvidence || []).slice(0, supplementalMax).map((item) => ({
        ...item,
        title: trimText(item.title, titleChars),
        summary: trimText(item.summary, summaryChars)
    }));
    const tier3AssistEvidence = (context.tier3AssistEvidence || []).slice(0, 2).map((item) => ({
        ...item,
        title: trimText(item.title, titleChars),
        summary: trimText(item.summary, summaryChars)
    }));

    const keptIds = new Set([...primaryEvidence, ...supplementalEvidence, ...tier3AssistEvidence].map((item) => item.id));
    const trimmedCatalog = {};
    for (const id of Object.keys(context.citationCatalog || {})) {
        if (keptIds.has(id)) {
            trimmedCatalog[id] = context.citationCatalog[id];
        }
    }

    return {
        ...context,
        primaryEvidence,
        supplementalEvidence,
        tier3AssistEvidence,
        citationCatalog: trimmedCatalog,
        conflictHints: (context.conflictHints || []).slice(0, aggressive ? 1 : 3).map((item) => trimText(item, aggressive ? 120 : 220))
    };
}

function canUseTier3Assist(context) {
    return !!(context?.tier3AssistEligible && (context?.tier3AssistEvidence || []).length > 0);
}

function withTier3Assist(context) {
    if (!canUseTier3Assist(context)) return context;
    const tier3 = (context.tier3AssistEvidence || []).slice(0, 2);
    if (!tier3.length) return context;

    if ((context.primaryEvidence || []).length === 0) {
        const [first, ...rest] = tier3;
        return {
            ...context,
            primaryEvidence: [first],
            supplementalEvidence: [...(context.supplementalEvidence || []), ...rest].slice(0, 3)
        };
    }

    return {
        ...context,
        supplementalEvidence: [...(context.supplementalEvidence || []), ...tier3].slice(0, 3)
    };
}

function extractCitationId(value) {
    if (typeof value === "string" || typeof value === "number") {
        return String(value).trim();
    }
    if (!value || typeof value !== "object") return "";
    const candidates = [
        value.id,
        value.citation,
        value.citation_id,
        value.source_id,
        value.pmid,
        value.trial_id
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" || typeof candidate === "number") {
            const normalized = String(candidate).trim();
            if (normalized) return normalized;
        }
    }
    return "";
}

function normalizeClaimCitations(claim) {
    const raw = []
        .concat(claim?.citations || [])
        .concat(claim?.citation_ids || [])
        .concat(claim?.sources || []);
    return raw.map(extractCitationId).filter(Boolean);
}

function textFromClaim(claim) {
    const text = claim?.text ?? claim?.statement ?? claim?.claim ?? "";
    return String(text).trim();
}

function validateClaimsAndCitations(payload, citationCatalog) {
    const allowedIds = new Set(Object.keys(citationCatalog || {}));
    const rawClaims = Array.isArray(payload?.claims) ? payload.claims : [];
    const validClaims = rawClaims
        .map((claim) => {
            const text = textFromClaim(claim);
            const citations = normalizeClaimCitations(claim)
                .filter((item) => item && allowedIds.has(item));
            return { text, citations };
        })
        .filter((claim) => claim.text && claim.citations.length > 0);
    const citedOnly = Array.isArray(payload?.citations)
        ? payload.citations.map(extractCitationId).filter((item) => item && allowedIds.has(item))
        : [];
    const mergedCitations = flattenClaimCitations(validClaims);
    for (const citation of citedOnly) {
        if (!mergedCitations.includes(citation)) mergedCitations.push(citation);
    }

    return {
        claims: validClaims,
        citations: mergedCitations
    };
}

function synthTier(context, validatedClaims) {
    const primaryCount = context.primaryEvidence.length;
    const claimCount = validatedClaims.claims.length;
    if (primaryCount >= 2 && claimCount >= 1) return "A";
    if (primaryCount >= 1 && (claimCount >= 1 || validatedClaims.citations.length > 0)) return "B";
    return "C";
}

function includesCaution(text) {
    return /evidence is partial;?\s*interpret cautiously/i.test(String(text || ""));
}

function dedupeCaution(text) {
    return String(text || "").replace(
        /(Evidence is partial;?\s*interpret cautiously\.?\s*){2,}/gi,
        "Evidence is partial; interpret cautiously. "
    ).trim();
}

function hasStructuredSignal(payload) {
    const points = Array.isArray(payload?.evidence_points)
        ? payload.evidence_points.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    const uncertainties = Array.isArray(payload?.uncertainties)
        ? payload.uncertainties.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    const spotlight = payload?.study_spotlight && typeof payload.study_spotlight === "object"
        ? payload.study_spotlight
        : null;
    return points.length > 0 || uncertainties.length > 0 || !!(spotlight && (spotlight.id || spotlight.title || spotlight.key_finding));
}

function ensureMultiStudyCoverage(citations, context) {
    const normalized = [...new Set((citations || []).filter(Boolean))];
    const evidenceCount = (context.primaryEvidence || []).length + (context.supplementalEvidence || []).length;
    if (evidenceCount < 3 || normalized.length >= 2) {
        return normalized;
    }
    const promoted = [
        ...(context.primaryEvidence || []).map((item) => item.id),
        ...(context.supplementalEvidence || []).map((item) => item.id)
    ].filter(Boolean);
    for (const id of promoted) {
        if (!normalized.includes(id)) {
            normalized.push(id);
        }
        if (normalized.length >= 2) break;
    }
    return normalized;
}

function fallbackCitationsFromContext(context, maxCount = 3) {
    const ranked = [
        ...(context.primaryEvidence || []).map((item) => item.id),
        ...(context.supplementalEvidence || []).map((item) => item.id)
    ].filter(Boolean);
    return [...new Set(ranked)].slice(0, maxCount);
}

function resolveConditionLabel(context = {}) {
    const disease = String(context?.disease || "").trim();
    if (disease) return disease;
    const query = String(context?.question || "").toLowerCase();
    if (query.includes("lung cancer")) return "lung cancer";
    if (query.includes("parkinson")) return "Parkinson's disease";
    if (query.includes("hiv")) return "HIV";
    if (query.includes("malaria")) return "malaria";
    return "this condition";
}

function buildNoUsableFallback(context) {
    const evidence = [
        ...(context.primaryEvidence || []),
        ...(context.supplementalEvidence || [])
    ].filter((item) => item && item.id);
    const citations = [...new Set(evidence.map((item) => item.id))].slice(0, 4);
    const citationsText = citations.length ? `Citations: ${citations.map((id) => `[${id}]`).join(" ")}` : "";

    const headlineItems = evidence
        .slice(0, 3)
        .map((item) => ({
            id: item.id,
            title: String(item.title || "").trim(),
            summary: String(item.summary || "").trim()
        }))
        .filter((item) => item.id);

    const claims = headlineItems
        .filter((item) => item.title || item.summary)
        .map((item) => ({
            text: item.summary || item.title,
            citations: [item.id]
        }))
        .slice(0, 3);

    const overviewLine = headlineItems.length
        ? `Evidence overview: ${headlineItems.map((item) => `- ${item.title || item.summary} [${item.id}]`).join(" ")}`
        : "Available studies are related but not specific enough to produce a high-confidence claim.";

    const query = String(context?.question || "").toLowerCase();
    const condition = resolveConditionLabel(context);
    const isLatestTreatment = /(latest|recent|current)/.test(query) && /(treatment|therapy|management|intervention)/.test(query);

    const direct = isLatestTreatment
        ? `Latest ${condition} treatment evidence points to active therapeutic strategy research, with regimen choice depending on subtype and clinical setting.`
        : "Insufficient direct evidence to provide a definitive answer for this exact phrasing.";
    const support = isLatestTreatment
        ? "Retrieved studies are relevant but not fully case-matched enough for a high-confidence single recommendation."
        : "Available studies are related but not specific enough to produce a high-confidence claim.";

    const answer = dedupeCaution([
        direct,
        support,
        overviewLine,
        "Evidence is partial; interpret cautiously.",
        citationsText
    ].filter(Boolean).join(" "));

    return {
        enabled: true,
        reason: "strict_structured_fallback",
        synthesisTier: "B",
        strictMode: true,
        answer,
        direct_answer: direct,
        supporting_explanation: support,
        evidence_points: headlineItems.map((item) => `${item.title || item.summary} [${item.id}]`).slice(0, 3),
        study_spotlight: {},
        uncertainties: ["Evidence remains limited for this subgroup/question form."],
        claims,
        citations,
        evidence_mixed: false,
        conflict_reason: "",
        conflict_details: []
    };
}

function buildDetailedAnswer(payload, direct, support, claimDerived, warning, citationsText) {
    const evidencePoints = Array.isArray(payload?.evidence_points)
        ? payload.evidence_points.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
        : [];
    const uncertainties = Array.isArray(payload?.uncertainties)
        ? payload.uncertainties.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
        : [];
    const spotlight = (payload?.study_spotlight && typeof payload.study_spotlight === "object")
        ? payload.study_spotlight
        : {};

    const sections = [];
    const lead = direct || claimDerived;
    if (lead) sections.push(lead);
    if (support) sections.push(support);
    if (evidencePoints.length) {
        sections.push(`Evidence overview: ${evidencePoints.map((item) => `- ${item}`).join(" ")}`);
    }

    const spotlightParts = [];
    if (spotlight.id) spotlightParts.push(`ID: ${spotlight.id}`);
    if (spotlight.title) spotlightParts.push(`Title: ${spotlight.title}`);
    if (spotlight.population) spotlightParts.push(`Population: ${spotlight.population}`);
    if (spotlight.key_finding) spotlightParts.push(`Key finding: ${spotlight.key_finding}`);
    if (spotlight.limitation) spotlightParts.push(`Limitation: ${spotlight.limitation}`);
    if (spotlightParts.length) {
        sections.push(`Study spotlight: ${spotlightParts.join(" | ")}`);
    }
    if (uncertainties.length) {
        sections.push(`Uncertainty: ${uncertainties.join(" | ")}`);
    }

    const base = sections.filter(Boolean).join(" ").trim();
    const shouldAddWarning = warning && !includesCaution(base);
    return dedupeCaution([base, shouldAddWarning ? warning : "", citationsText].filter(Boolean).join(" ").trim());
}

async function synthesizeTieredAnswerWithLLM(context) {
    const enabled = String(process.env.ENABLE_LLM_TIERED_SYNTHESIS || "true").toLowerCase() === "true";
    const strict = String(process.env.STRICT_LLM_CHAT || "false").toLowerCase() === "true";
    if (!enabled || !context || (!context.primaryEvidence.length && !context.supplementalEvidence.length)) {
        if (strict) {
            return buildNoUsableFallback(context || {
                question: "",
                primaryEvidence: [],
                supplementalEvidence: [],
                citationCatalog: {}
            });
        }
        return null;
    }

    const runSynthesis = async (ctx) => {
        const timeoutMs = toPositiveInt(process.env.LLM_SYNTHESIS_HTTP_TIMEOUT_MS, 25000);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(`${getIngestionBaseUrl()}/synthesize-tiered`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    query: ctx.question || "",
                    disease: ctx.disease || "",
                    intent: ctx.intent || "",
                    retrieval_mode: ctx.retrieval_mode || "",
                    primary_evidence: ctx.primaryEvidence,
                    supplemental_evidence: ctx.supplementalEvidence,
                    citation_catalog: ctx.citationCatalog,
                    conflict_hints: ctx.conflictHints,
                    conflict_level: ctx.conflictLevel
                })
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
            const error = new Error(`synthesize-tiered failed with status ${response.status}`);
            error.transient = transientStatuses.has(response.status);
            throw error;
        }
        return response.json();
    };

    const runWithRetry = async (ctx) => {
        const attempts = toPositiveInt(process.env.LLM_SYNTHESIS_TOTAL_ATTEMPTS, 2);
        const baseBackoffMs = toPositiveInt(process.env.LLM_SYNTHESIS_RETRY_BACKOFF_MS, 800);
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const payload = await runSynthesis(ctx);
                const reason = String(payload?.reason || "");
                const transientReason = reason.startsWith("error:");
                const shouldRetry = !payload?.enabled && transientReason && attempt < attempts;
                if (shouldRetry) {
                    await sleep(baseBackoffMs * attempt);
                    continue;
                }
                return payload;
            } catch (error) {
                lastError = error;
                const isTransient = !!error?.transient || String(error?.name || "").includes("Abort");
                if (!isTransient || attempt >= attempts) {
                    throw error;
                }
                await sleep(baseBackoffMs * attempt);
            }
        }

        if (lastError) throw lastError;
        throw new Error("synthesize-tiered failed after retries");
    };

    try {
        const attemptSynthesis = async (baseContext, allowAggressiveRetry = true) => {
            let payload = await runWithRetry(baseContext);
            const aggressiveRetryEnabled = String(process.env.LLM_SYNTHESIS_ALLOW_AGGRESSIVE_RETRY || "false").toLowerCase() === "true";
            if (!payload.enabled && strict && allowAggressiveRetry && aggressiveRetryEnabled) {
                payload = await runWithRetry(trimContext(baseContext, strict, true));
            }
            if (!payload.enabled) {
                return { ok: false, reason: payload.reason || "disabled", contextUsed: baseContext };
            }

            const validated = validateClaimsAndCitations(payload, baseContext.citationCatalog);
            const tier = synthTier(baseContext, validated);
            const direct = String(payload.direct_answer || "").trim();
            const support = String(payload.supporting_explanation || "").trim();
            const claimDerived = validated.claims.slice(0, 2).map((claim) => claim.text).filter(Boolean).join(" ");
            const structuredSignal = hasStructuredSignal(payload);

            if (!direct && !support && !claimDerived && !structuredSignal) {
                return { ok: false, reason: "no_usable_answer", contextUsed: baseContext };
            }
            if (tier === "C" && !strict) {
                return { ok: false, reason: "tier_c_non_strict", contextUsed: baseContext };
            }

            const synthesizedDirect = direct || (structuredSignal ? "The retrieved evidence provides partial but relevant findings." : "");
            const synthesizedSupport = support || (structuredSignal ? "The studies are informative but do not fully resolve the question." : "");
            let citations = ensureMultiStudyCoverage(validated.citations, baseContext);
            if (!citations.length && structuredSignal) {
                citations = fallbackCitationsFromContext(baseContext, 3);
            }
            const citationsText = citations.length ? `Citations: ${citations.map((id) => `[${id}]`).join(" ")}` : "";
            const warning = (tier === "B" || (strict && tier === "C")) ? "Evidence is partial; interpret cautiously." : "";
            const answer = buildDetailedAnswer(payload, synthesizedDirect, synthesizedSupport, claimDerived, warning, citationsText);

            return {
                ok: true,
                payload,
                validated,
                tier,
                answer: dedupeCaution(answer),
                synthesizedDirect,
                synthesizedSupport,
                citations,
                contextUsed: baseContext
            };
        };

        const compactContext = trimContext(context, strict, false);
        let result = await attemptSynthesis(compactContext, true);
        let usedTier3Assist = false;

        if (!result.ok && canUseTier3Assist(compactContext)) {
            const assisted = trimContext(withTier3Assist(compactContext), strict, false);
            const retry = await attemptSynthesis(assisted, true);
            if (retry.ok) {
                result = retry;
                usedTier3Assist = true;
            }
        }

        if (!result.ok) {
            if (strict) {
                return buildNoUsableFallback(compactContext);
            }
            return null;
        }

        return {
            enabled: true,
            reason: usedTier3Assist ? "ok_tier3_assist" : "ok",
            synthesisTier: strict && result.tier === "C" ? "B" : result.tier,
            strictMode: strict,
            answer: result.answer,
            direct_answer: result.synthesizedDirect,
            supporting_explanation: result.synthesizedSupport,
            evidence_points: result.payload.evidence_points || [],
            study_spotlight: result.payload.study_spotlight || {},
            uncertainties: result.payload.uncertainties || [],
            claims: result.validated.claims,
            citations: result.citations,
            evidence_mixed: !!result.payload.evidence_mixed,
            conflict_reason: result.payload.conflict_reason || "",
            conflict_details: result.payload.conflict_details || []
        };
    } catch (error) {
        console.warn("Tiered synthesis unavailable:", error.message);
        if (strict) {
            throw new Error(`Strict LLM mode: ${error.message}`);
        }
        return null;
    }
}

module.exports = {
    synthesizeTieredAnswerWithLLM
};
