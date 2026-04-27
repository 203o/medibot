const { createId } = require("../utils/id");
const { buildIntent, isLikelyMedicalQuery, parseGreeting, greetingReply, buildCaseRetrievalQuery } = require("../services/context.service");
const { routeIntent } = require("../services/intent-router.service");
const { autofillMedicalContext } = require("../services/context-autofill.service");
const { runReasoningHead } = require("../services/reasoning-head.service");
const { retrieveEvidence } = require("../services/retrieval.service");
const { rankEvidence } = require("../services/ranking.service");
const { enrichEvidenceWithSemanticJudge } = require("../services/semantic-judge.service");
const { buildChatContext } = require("../services/context-builder.service");
const { synthesizeTieredAnswerWithLLM } = require("../services/llm-synthesis.service");
const { planFollowupReuse, mergeEvidencePools } = require("../services/followup-refinement.service");
const { buildFinalResponse } = require("../services/grounding.service");
const {
    getSessionBundle,
    saveUserTurn,
    saveAssistantTurn,
    persistSessionState
} = require("../services/memory.service");

function looksLikeFollowupPhrase(message = "") {
    const text = String(message || "").trim().toLowerCase();
    return /^(what about|how about|and |in |for |is there|how does|what of|recheck|rechek|explain|elaborate)/.test(text);
}

async function processTurn({ sessionId, message, medicalContext, onStage = () => {} }) {
    if (!String(message).trim()) {
        const error = new Error("message is required");
        error.status = 400;
        throw error;
    }

    const bundle = await getSessionBundle(sessionId);
    const greeting = parseGreeting(message, medicalContext);
    const handoffMessage = greeting.isGreeting ? (greeting.strippedMessage || "") : "";

    if (greeting.isGreeting && !greeting.hasMedicalContext && !handoffMessage) {
        onStage("greeting_skipped_retrieval", {
            sessionId,
            variant: greeting.variant || "generic",
            reason: "pure_greeting"
        });
        const greetingResponse = {
            sessionId,
            query: message,
            medicalContext: {
                disease: medicalContext?.disease || "",
                intent: medicalContext?.intent || "",
                location: medicalContext?.location || "",
                retrievalMode: "greeting"
            },
            answer: greetingReply(greeting.variant || "generic"),
            supplement: "",
            insights: [`Greeting detected (${greeting.variant || "generic"}); retrieval was skipped.`],
            confidence: "low",
            evidence: [],
            retrieval: {
                mode: "greeting",
                source: "guardrail",
                publicationsCount: 0,
                pubmedCount: 0,
                openalexCount: 0,
                trialsCount: 0,
                rankedCount: 0,
                llmSynthesis: null,
                followup: null,
                contextBuilder: null,
                tierBreakdown: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
                sourcePolicy: {},
                policy: {},
                stages: []
            },
            sourceMapping: [],
            validation: {
                isValid: false,
                confidence: "low",
                checks: [
                    {
                        name: "Scope check",
                        status: "warn",
                        detail: "Greeting detected; no retrieval performed."
                    }
                ]
            },
            memory: {
                conditions: bundle.memory?.conditions || [],
                intents: bundle.memory?.intents || [],
                symptoms: bundle.memory?.symptoms || [],
                substances: bundle.memory?.substances || [],
                riskFlags: bundle.memory?.riskFlags || [],
                location: bundle.memory?.location || { raw: "", normalized: "", tokens: [] },
                previousEvidenceIds: bundle.memory?.lastEvidenceIds || [],
                lastRetrievedIds: bundle.memory?.lastRetrievedIds || [],
                lastRetrievedEvidenceCount: (bundle.memory?.lastRetrievedEvidence || []).length,
                lastAnswerFocus: bundle.memory?.lastAnswerFocus || "other",
                lastQueryFacets: bundle.memory?.lastQueryFacets || {}
            },
            conversation: {
                grounded: true,
                previousAnswerSummary: bundle.memory?.lastAnswerSummary || "",
                retrievalMode: "greeting",
                retrievalPolicy: {}
            }
        };
        await saveUserTurn(sessionId, message, { intent: medicalContext?.intent || "", retrievalMode: "greeting" }, bundle.memory);
        await saveAssistantTurn(sessionId, {
            answer: greetingResponse.answer,
            evidenceIds: [],
            sourceMapping: [],
            validation: greetingResponse.validation,
            memorySnapshot: greetingResponse.memory
        });
        return greetingResponse;
    }

    let effectiveMessage = handoffMessage || message;
    const caseRewrite = buildCaseRetrievalQuery(effectiveMessage);
    if (caseRewrite.enabled) {
        effectiveMessage = caseRewrite.query;
        if (!medicalContext?.disease && caseRewrite.disease) {
            medicalContext = {
                ...(medicalContext || {}),
                disease: caseRewrite.disease
            };
        }
        if (!medicalContext?.intent) {
            medicalContext = {
                ...(medicalContext || {}),
                intent: caseRewrite.query
            };
        }
        onStage("case_query_rewritten", {
            sessionId,
            reason: caseRewrite.reason,
            diseaseHint: caseRewrite.disease || "",
            rewrittenQuery: effectiveMessage
        });
    }

    const autofillResult = await autofillMedicalContext({
        message: effectiveMessage,
        medicalContext,
        previousMemory: bundle.memory || {}
    });
    medicalContext = autofillResult.medicalContext;
    onStage("context_autofill", {
        sessionId,
        ...autofillResult.meta,
        disease: medicalContext?.disease || "",
        location: medicalContext?.location || ""
    });

    // LLM pre-normalization now runs before out-of-scope guardrail.
    const preNormalizationIntent = buildIntent(effectiveMessage, medicalContext, bundle.memory);
    const preNormalizationReasoning = await runReasoningHead({
        message: effectiveMessage,
        intent: preNormalizationIntent,
        previousMemory: bundle.memory,
        turns: bundle.turns || []
    });
    if (preNormalizationReasoning?.enabled && String(preNormalizationReasoning.refined_query || "").trim()) {
        const normalized = String(preNormalizationReasoning.refined_query || "").trim();
        if (normalized && normalized !== effectiveMessage) {
            onStage("query_prenormalized", {
                sessionId,
                from: effectiveMessage,
                to: normalized,
                provider: preNormalizationReasoning.provider || "",
                model: preNormalizationReasoning.model || "",
                reason: preNormalizationReasoning.explanation || preNormalizationReasoning.reason || "llm_prenormalization"
            });
            effectiveMessage = normalized;
        }
    }

    const likelyMedical = isLikelyMedicalQuery(effectiveMessage, medicalContext)
        || !!(preNormalizationReasoning?.enabled && preNormalizationReasoning.attachment !== "out_of_scope");

    if (!likelyMedical && !looksLikeFollowupPhrase(effectiveMessage)) {
        const fallback = {
            sessionId,
            query: effectiveMessage,
            medicalContext: {
                disease: medicalContext?.disease || "",
                intent: medicalContext?.intent || "",
                location: medicalContext?.location || "",
                retrievalMode: "out_of_scope"
            },
            answer: "This assistant is designed for medical evidence questions. I can still help if you ask about a disease, treatment, prevalence, clinical trials, or outcomes.",
            supplement: "",
            insights: ["Query appears outside medical-evidence scope."],
            confidence: "low",
            evidence: [],
            retrieval: {
                mode: "out_of_scope",
                source: "guardrail",
                publicationsCount: 0,
                pubmedCount: 0,
                openalexCount: 0,
                trialsCount: 0,
                rankedCount: 0,
                llmSynthesis: null,
                followup: null,
                contextBuilder: null,
                tierBreakdown: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
                sourcePolicy: {},
                policy: {},
                stages: []
            },
            sourceMapping: [],
            validation: {
                isValid: false,
                confidence: "low",
                checks: [
                    {
                        name: "Scope check",
                        status: "warn",
                        detail: "Handled as non-medical query."
                    }
                ]
            },
            memory: {
                conditions: bundle.memory?.conditions || [],
                intents: bundle.memory?.intents || [],
                symptoms: bundle.memory?.symptoms || [],
                substances: bundle.memory?.substances || [],
                riskFlags: bundle.memory?.riskFlags || [],
                location: bundle.memory?.location || { raw: "", normalized: "", tokens: [] },
                previousEvidenceIds: bundle.memory?.lastEvidenceIds || [],
                lastRetrievedIds: bundle.memory?.lastRetrievedIds || [],
                lastRetrievedEvidenceCount: (bundle.memory?.lastRetrievedEvidence || []).length,
                lastAnswerFocus: bundle.memory?.lastAnswerFocus || "other",
                lastQueryFacets: bundle.memory?.lastQueryFacets || {}
            },
            conversation: {
                grounded: true,
                previousAnswerSummary: bundle.memory?.lastAnswerSummary || "",
                retrievalMode: "out_of_scope",
                retrievalPolicy: {}
            }
        };
        await saveUserTurn(sessionId, message, { intent: medicalContext?.intent || "", retrievalMode: "out_of_scope" }, bundle.memory);
        await saveAssistantTurn(sessionId, {
            answer: fallback.answer,
            evidenceIds: [],
            sourceMapping: [],
            validation: fallback.validation,
            memorySnapshot: fallback.memory
        });
        return fallback;
    }

    const baseIntent = buildIntent(effectiveMessage, medicalContext, bundle.memory);
    const reasoningHead = preNormalizationReasoning?.enabled
        ? preNormalizationReasoning
        : await runReasoningHead({
            message: effectiveMessage,
            intent: baseIntent,
            previousMemory: bundle.memory,
            turns: bundle.turns || []
        });
    const routedIntent = reasoningHead?.enabled
        ? {
            retrievalMode: reasoningHead.retrieval_mode || baseIntent.retrievalMode || "clinical_guidance",
            routeConfidence: Number(reasoningHead.confidence || 0),
            routeReasoning: `Unified reasoning head. ${reasoningHead.explanation || ""}`.trim(),
            routeScores: {},
            routeDecisionSource: "reasoning_head",
            routeEmbeddingMode: "",
            routeLlmRefinement: {
                provider: reasoningHead.provider || "",
                model: reasoningHead.model || "",
                reason: reasoningHead.reason || "ok",
                attachment: reasoningHead.attachment || "root",
                isFollowup: !!reasoningHead.is_followup,
                shouldRefetch: reasoningHead.should_refetch !== false,
                refinedQuery: reasoningHead.refined_query || "",
                refinedIntent: reasoningHead.intent || ""
            },
            sourcePolicy: baseIntent.sourcePolicy
        }
        : await routeIntent(effectiveMessage, baseIntent);
    let intent = {
        ...baseIntent,
        ...routedIntent
    };

    await saveUserTurn(sessionId, message, intent, bundle.memory);

    const followupPlan = await planFollowupReuse({
        message: effectiveMessage,
        intent,
        previousMemory: bundle.memory,
        turns: bundle.turns || [],
        reasoningHead
    });

    if (followupPlan.frame) {
        intent = {
            ...intent,
            ...followupPlan.frame.intentOverrides,
            activeCaseFrame: followupPlan.frame
        };
    }

    if (followupPlan.clarifyNeeded) {
        const clarificationAnswer = followupPlan.clarifyPrompt || "What aspect of this condition are you asking about?";
        const clarificationMemory = {
            ...(bundle.memory || {}),
            activeCaseFrame: followupPlan.frame || bundle.memory?.activeCaseFrame || {},
            lastAnswerSummary: clarificationAnswer,
            lastEvidenceIds: bundle.memory?.lastEvidenceIds || [],
            lastRetrievedIds: bundle.memory?.lastRetrievedIds || [],
            lastRetrievedEvidence: bundle.memory?.lastRetrievedEvidence || [],
            lastAnswerFocus: bundle.memory?.lastAnswerFocus || "other",
            lastQueryFacets: {
                disease: followupPlan.frame?.disease || intent.disease || "",
                location: followupPlan.frame?.location || intent.location?.normalized || "",
                retrievalMode: "clarification",
                substances: intent.substances || [],
                symptoms: intent.symptoms || []
            }
        };
        const clarificationResponse = {
            sessionId,
            query: effectiveMessage,
            medicalContext: {
                disease: followupPlan.frame?.disease || intent.disease || "",
                intent: followupPlan.frame?.intent || intent.intent || "",
                location: followupPlan.frame?.location || intent.location?.normalized || "",
                retrievalMode: "clarification"
            },
            answer: clarificationAnswer,
            answerBasis: "clarification",
            supplement: "",
            insights: [followupPlan.reuseReason || "Conversation frame is too broad to safely refetch without a narrower disease anchor."],
            confidence: "low",
            evidence: [],
            retrieval: {
                mode: "clarification",
                source: "conversation_frame",
                publicationsCount: 0,
                pubmedCount: 0,
                openalexCount: 0,
                trialsCount: 0,
                rankedCount: 0,
                llmSynthesis: null,
                followup: {
                    isFollowup: true,
                    shouldRefetch: false,
                    reason: followupPlan.reuseReason || "conversation_frame_clarify",
                    decisionReason: followupPlan.followupDecisionReason || "",
                    expansion: followupPlan.expansion || null,
                    attachment: followupPlan.attachment || null,
                    reuseStats: followupPlan.reuseStats || { poolCount: 0, matchedCount: 0, coverageScore: 0 }
                },
                contextBuilder: null,
                tierBreakdown: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
                sourcePolicy: {},
                policy: {},
                stages: []
            },
            sourceMapping: [],
            validation: {
                isValid: false,
                confidence: "low",
                checks: [
                    {
                        name: "Conversation frame",
                        status: "warn",
                        detail: followupPlan.clarifyPrompt || "Clarification needed before refetching."
                    }
                ]
            },
            memory: clarificationMemory,
            conversation: {
                grounded: true,
                previousAnswerSummary: bundle.memory?.lastAnswerSummary || "",
                retrievalMode: "clarification",
                retrievalPolicy: {}
            }
        };
        await saveAssistantTurn(sessionId, {
            answer: clarificationResponse.answer,
            evidenceIds: [],
            sourceMapping: [],
            validation: clarificationResponse.validation,
            memorySnapshot: clarificationResponse.memory
        });
        await persistSessionState(sessionId, {
            sessionId,
            ...clarificationResponse.memory,
            lastAnswerSummary: clarificationResponse.answer,
            lastEvidenceIds: []
        }, {
            lastMessage: effectiveMessage,
            lastConfidence: clarificationResponse.confidence
        });
        return clarificationResponse;
    }

    if (followupPlan.forceOutOfScope) {
        const fallback = {
            sessionId,
            query: effectiveMessage,
            medicalContext: {
                disease: intent.disease || "",
                intent: intent.intent || "",
                location: intent.location?.normalized || "",
                retrievalMode: "out_of_scope"
            },
            answer: "This follow-up appears outside the current medical evidence scope. Ask a clinical question and I will continue from your evidence context.",
            supplement: "",
            insights: ["LLM intent attachment classified this turn as out_of_scope."],
            confidence: "low",
            evidence: [],
            retrieval: {
                mode: "out_of_scope",
                source: "followup_attachment_guardrail",
                publicationsCount: 0,
                pubmedCount: 0,
                openalexCount: 0,
                trialsCount: 0,
                rankedCount: 0,
                llmSynthesis: null,
                followup: {
                    isFollowup: true,
                    shouldRefetch: false,
                    reason: followupPlan.reuseReason || "attachment_out_of_scope",
                    decisionReason: followupPlan.followupDecisionReason || "",
                    expansion: followupPlan.expansion || null,
                    attachment: followupPlan.attachment || null
                },
                contextBuilder: null,
                tierBreakdown: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
                sourcePolicy: {},
                policy: {},
                stages: []
            },
            sourceMapping: [],
            validation: {
                isValid: false,
                confidence: "low",
                checks: [
                    {
                        name: "Intent attachment",
                        status: "warn",
                        detail: "Follow-up was classified as out_of_scope."
                    }
                ]
            },
            memory: {
                conditions: bundle.memory?.conditions || [],
                intents: bundle.memory?.intents || [],
                symptoms: bundle.memory?.symptoms || [],
                substances: bundle.memory?.substances || [],
                riskFlags: bundle.memory?.riskFlags || [],
                location: bundle.memory?.location || { raw: "", normalized: "", tokens: [] },
                previousEvidenceIds: bundle.memory?.lastEvidenceIds || [],
                lastRetrievedIds: bundle.memory?.lastRetrievedIds || [],
                lastRetrievedEvidenceCount: (bundle.memory?.lastRetrievedEvidence || []).length,
                lastAnswerFocus: bundle.memory?.lastAnswerFocus || "other",
                lastQueryFacets: bundle.memory?.lastQueryFacets || {}
            },
            conversation: {
                grounded: true,
                previousAnswerSummary: bundle.memory?.lastAnswerSummary || "",
                retrievalMode: "out_of_scope",
                retrievalPolicy: {}
            }
        };
        await saveAssistantTurn(sessionId, {
            answer: fallback.answer,
            evidenceIds: [],
            sourceMapping: [],
            validation: fallback.validation,
            memorySnapshot: fallback.memory
        });
        return fallback;
    }

    onStage("retrieval_started", {
        sessionId,
        retrievalMode: intent.retrievalMode,
        followup: {
            isFollowup: followupPlan.isFollowup,
            shouldRefetch: followupPlan.shouldRefetch,
            reason: followupPlan.reuseReason,
            decisionReason: followupPlan.followupDecisionReason || "",
            expansion: followupPlan.expansion || null,
            attachment: followupPlan.attachment || null
        }
    });

    let retrieved = {
        source: "memory_refinement",
        ingestion: null,
        publications: (followupPlan.reusedEvidence || []).filter((item) => item.source === "pubmed" || item.source === "openalex"),
        pubmedPublications: (followupPlan.reusedEvidence || []).filter((item) => item.source === "pubmed"),
        openalexPublications: (followupPlan.reusedEvidence || []).filter((item) => item.source === "openalex"),
        trials: (followupPlan.reusedEvidence || []).filter((item) => item.source === "clinicaltrials"),
        combined: followupPlan.reusedEvidence || []
    };

    if (!followupPlan.isFollowup || followupPlan.shouldRefetch) {
        const fetched = await retrieveEvidence(followupPlan.fetchIntent || intent, { sessionId });
        const mergedCombined = followupPlan.isFollowup
            ? mergeEvidencePools(followupPlan.reusedEvidence || [], fetched.combined || [])
            : (fetched.combined || []);

        const mergedPublications = mergedCombined.filter((item) => item.source === "pubmed" || item.source === "openalex");
        const mergedPubMed = mergedCombined.filter((item) => item.source === "pubmed");
        const mergedOpenAlex = mergedCombined.filter((item) => item.source === "openalex");
        const mergedTrials = mergedCombined.filter((item) => item.source === "clinicaltrials");

        retrieved = {
            ...fetched,
            source: followupPlan.isFollowup ? "hybrid_followup_refinement" : fetched.source,
            publications: mergedPublications,
            pubmedPublications: mergedPubMed,
            openalexPublications: mergedOpenAlex,
            trials: mergedTrials,
            combined: mergedCombined
        };
    }

    const messageForReasoning = effectiveMessage;
    const classifiedEvidence = await enrichEvidenceWithSemanticJudge(retrieved.combined, intent, messageForReasoning);
    const rankedEvidence = rankEvidence(classifiedEvidence, intent);
    onStage("ranking_done", {
        rankedCount: rankedEvidence.length,
        publicationsCount: retrieved.publications.length,
        trialsCount: retrieved.trials.length
    });

    const chatContext = buildChatContext(intent, rankedEvidence, messageForReasoning);
    onStage("synthesis_started", {
        primaryCount: chatContext.primaryEvidence.length,
        supplementalCount: chatContext.supplementalEvidence.length,
        usedLowerTierFallback: !!chatContext.usedLowerTierFallback,
        conflictLevel: chatContext.conflictLevel
    });
    const llmSynthesis = await synthesizeTieredAnswerWithLLM(chatContext);

    const finalResponse = buildFinalResponse({
        sessionId,
        message: effectiveMessage,
        intent,
        rankedEvidence,
        previousMemory: bundle.memory,
        retrievalMeta: {
            caseMode: !!caseRewrite.enabled,
            autofill: autofillResult.meta,
            source: retrieved.source,
            publicationsCount: retrieved.publications.length,
            pubmedCount: retrieved.pubmedPublications?.length || retrieved.publications.length,
            openalexCount: retrieved.openalexPublications?.length || 0,
            trialsCount: retrieved.trials.length,
            ingestionRunId: retrieved.ingestion?.runId || "",
            ingestionOutputDir: retrieved.ingestion?.outputDir || "",
            queryPlan: retrieved.ingestion?.queryPlan || null,
            followup: {
                isFollowup: followupPlan.isFollowup,
                constraint: followupPlan.constraint || "",
                reconstructedQuery: followupPlan.reconstructedQuery || "",
                refinedFromMemory: followupPlan.isFollowup,
                shouldRefetch: followupPlan.shouldRefetch,
                reason: followupPlan.reuseReason,
                decisionReason: followupPlan.followupDecisionReason || "",
                expansion: followupPlan.expansion || null,
                attachment: followupPlan.attachment || null,
                reuseStats: followupPlan.reuseStats || {
                    poolCount: 0,
                    matchedCount: 0,
                    coverageScore: 0
                }
            },
            llmSynthesis,
            chatContext
        }
    });

    onStage("citations_resolved", {
        citationsCount: (finalResponse.sourceMapping || []).reduce((count, item) => count + ((item.sources || []).length || 0), 0),
        claimsCount: (finalResponse.sourceMapping || []).length
    });

    await saveAssistantTurn(sessionId, {
        answer: finalResponse.answer,
        evidenceIds: finalResponse.evidence.map((item) => item.id),
        sourceMapping: finalResponse.sourceMapping,
        validation: finalResponse.validation,
        memorySnapshot: finalResponse.memory
    });

    await persistSessionState(sessionId, {
        sessionId,
        ...finalResponse.memory,
        lastAnswerSummary: finalResponse.answer,
        lastEvidenceIds: finalResponse.evidence.map((item) => item.id)
    }, {
        lastMessage: effectiveMessage,
        lastConfidence: finalResponse.confidence
    });

    return finalResponse;
}

async function createTurn(req, res) {
    const {
        sessionId = createId("session"),
        message = "",
        medicalContext = {}
    } = req.body || {};

    const finalResponse = await processTurn({
        sessionId,
        message,
        medicalContext
    });

    res.json(finalResponse);
}

async function createTurnStream(req, res) {
    const {
        sessionId = createId("session"),
        message = "",
        medicalContext = {}
    } = req.body || {};

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) {
        res.flushHeaders();
    }

    const send = (event, payload = {}) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
        send("retrieval_started", { sessionId });
        const finalResponse = await processTurn({
            sessionId,
            message,
            medicalContext,
            onStage: (event, payload) => send(event, payload)
        });
        send("final_answer", finalResponse);
    } catch (error) {
        send("error", { message: error.message, status: error.status || 500 });
    } finally {
        res.end();
    }
}

module.exports = {
    createTurn,
    createTurnStream
};
