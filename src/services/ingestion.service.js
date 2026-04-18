const fs = require("fs/promises");
const path = require("path");

const IngestionRun = require("../models/IngestionRun");
const { isMongoReady } = require("../config/database");
const { store } = require("./stores/in-memory.store");

function getIngestionBaseUrl() {
    return process.env.FASTAPI_INGESTION_URL || "http://127.0.0.1:8001";
}

function getSourceFetchMaxResults() {
    return Number(process.env.INGESTION_SOURCE_FETCH_K || process.env.INGESTION_MAX_RESULTS || 150);
}

const QUERY_STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with",
    "what", "which", "how", "does", "do", "is", "are", "can", "could", "should", "would",
    "latest", "new", "current", "question", "please", "give", "tell"
]);

function normalizeQueryText(value = "") {
    const tokens = String(value || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const seen = new Set();
    const deduped = [];
    for (const token of tokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        deduped.push(token);
    }
    return deduped.join(" ").trim();
}

function fallbackTopicLabel(...parts) {
    const text = normalizeQueryText(parts.filter(Boolean).join(" "));
    const tokens = text
        .split(/\s+/)
        .filter((token) => token.length > 2 && !QUERY_STOPWORDS.has(token))
        .slice(0, 3);
    return tokens.join(" ").trim();
}

function buildMedicalContext(intent) {
    const retrievalIntent = normalizeQueryText(intent.retrievalQuery || intent.intent || "clinical_question");
    const disease = intent.disease || intent.conditions?.[0] || fallbackTopicLabel(retrievalIntent);
    return {
        disease: disease || retrievalIntent || "medical",
        intent: retrievalIntent || "clinical question",
        location: intent.location?.normalized || ""
    };
}

function normalizePubMedRecord(record, semanticHit = null) {
    return {
        id: record.pmid || "unknown-pubmed",
        source: "pubmed",
        title: record.title || "Untitled publication",
        journal: record.journal || "PubMed",
        year: Number(record.year) || null,
        publishedAt: record.year || "",
        authors: record.authors || [],
        url: record.source_url || "",
        snippet: (semanticHit?.matched_sentences && semanticHit.matched_sentences[0]) || (record.evidence_sentences && record.evidence_sentences[0]) || record.abstract || record.title || "",
        evidenceSentences: record.evidence_sentences || [],
        matchedSentences: semanticHit?.matched_sentences || [],
        semanticScore: semanticHit?.semantic_score || 0,
        studyType: (record.publication_types || []).join(", ") || "Publication",
        publicationTypes: record.publication_types || [],
        raw: record
    };
}

function normalizeClinicalTrialRecord(record, semanticHit = null) {
    return {
        id: record.nct_id || "unknown-trial",
        source: "clinicaltrials",
        title: record.title || "Untitled trial",
        journal: "ClinicalTrials.gov",
        year: Number(String(record.last_update || "").slice(0, 4)) || null,
        publishedAt: record.last_update || "",
        authors: [],
        url: record.source_url || "",
        snippet: (semanticHit?.matched_sentences && semanticHit.matched_sentences[0]) || (record.evidence_sentences && record.evidence_sentences[0]) || record.brief_summary || record.detailed_description || record.title || "",
        evidenceSentences: record.evidence_sentences || [],
        matchedSentences: semanticHit?.matched_sentences || [],
        semanticScore: semanticHit?.semantic_score || 0,
        studyType: [record.study_type, ...(record.phases || [])].filter(Boolean).join(", ") || "Clinical trial",
        status: record.status || "",
        phases: record.phases || [],
        locations: [],
        raw: record.raw || record
    };
}

function normalizeOpenAlexRecord(record, semanticHit = null) {
    return {
        id: record.openalex_id || "unknown-openalex",
        source: "openalex",
        title: record.title || "Untitled publication",
        journal: "OpenAlex",
        year: Number(record.publication_year || record.year) || null,
        publishedAt: record.publication_date || String(record.publication_year || record.year || ""),
        authors: record.authors || [],
        url: record.source_url || "",
        snippet: (semanticHit?.matched_sentences && semanticHit.matched_sentences[0]) || (record.evidence_sentences && record.evidence_sentences[0]) || record.abstract || record.summary || record.title || "",
        evidenceSentences: record.evidence_sentences || [],
        matchedSentences: semanticHit?.matched_sentences || [],
        semanticScore: semanticHit?.semantic_score || 0,
        studyType: record.type || "Publication",
        publicationTypes: record.type ? [record.type] : [],
        raw: record.raw || record
    };
}

async function readCombinedRecords(outputDir) {
    const combinedPath = path.join(outputDir, "combined.records.json");
    const raw = await fs.readFile(combinedPath, "utf8");
    const payload = JSON.parse(raw);
    const semanticMap = new Map(
        (payload.semantic_hits || []).map((hit) => [`${hit.source}:${hit.doc_id}`, hit])
    );
    return {
        filePath: combinedPath,
        payload,
        queryPlan: {
            originalQuery: payload.query || "",
            expandedQueries: payload.expanded_queries || [],
            heuristicFallbacks: payload.heuristic_fallbacks || [],
            finalQueries: payload.query_fallbacks || [],
            expansion: payload.query_expansion || {}
        },
        publications: (payload.pubmed_records || []).map((record) => normalizePubMedRecord(record, semanticMap.get(`pubmed:${record.pmid}`))),
        openalexPublications: (payload.openalex_records || []).map((record) => normalizeOpenAlexRecord(record, semanticMap.get(`openalex:${record.openalex_id}`))),
        trials: (payload.clinical_trials_records || []).map((record) => normalizeClinicalTrialRecord(record, semanticMap.get(`clinicaltrials:${record.nct_id}`)))
    };
}

function readCombinedRecordsFromPayload(combinedPayload = {}) {
    const payload = combinedPayload || {};
    const semanticMap = new Map(
        (payload.semantic_hits || []).map((hit) => [`${hit.source}:${hit.doc_id}`, hit])
    );
    return {
        filePath: "",
        payload,
        queryPlan: {
            originalQuery: payload.query || "",
            expandedQueries: payload.expanded_queries || [],
            heuristicFallbacks: payload.heuristic_fallbacks || [],
            finalQueries: payload.query_fallbacks || [],
            expansion: payload.query_expansion || {}
        },
        publications: (payload.pubmed_records || []).map((record) => normalizePubMedRecord(record, semanticMap.get(`pubmed:${record.pmid}`))),
        openalexPublications: (payload.openalex_records || []).map((record) => normalizeOpenAlexRecord(record, semanticMap.get(`openalex:${record.openalex_id}`))),
        trials: (payload.clinical_trials_records || []).map((record) => normalizeClinicalTrialRecord(record, semanticMap.get(`clinicaltrials:${record.nct_id}`)))
    };
}

async function persistIngestionRun(sessionId, response, combinedCount) {
    const doc = {
        sessionId,
        runId: response.run_id,
        query: response.query,
        sources: response.sources || [],
        outputDir: response.output_dir,
        manifestPath: response.manifest_path,
        counts: {
            pubmed: response.pubmed_count || 0,
            clinicaltrials: response.clinical_trials_count || 0,
            openalex: response.openalex_count || 0,
            combined: combinedCount
        },
        status: "completed"
    };

    if (isMongoReady() && IngestionRun) {
        await IngestionRun.findOneAndUpdate(
            { runId: doc.runId },
            doc,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return;
    }

    store.ingestionRuns.set(doc.runId, doc);
}

async function ingestEvidence(intent, options = {}) {
    const baseUrl = getIngestionBaseUrl();
    const response = await fetch(`${baseUrl}/ingest`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            medical_context: buildMedicalContext(intent),
            max_results: getSourceFetchMaxResults(),
            sources: ["pubmed", "clinicaltrials", "openalex"]
        })
    });

    if (!response.ok) {
        throw new Error(`FastAPI ingestion failed with status ${response.status}`);
    }

    const payload = await response.json();
    let combined;
    if (payload.combined_records && typeof payload.combined_records === "object") {
        combined = readCombinedRecordsFromPayload(payload.combined_records);
    } else {
        combined = await readCombinedRecords(payload.output_dir);
    }
    const normalized = {
        runId: payload.run_id,
        outputDir: payload.output_dir,
        manifestPath: payload.manifest_path,
        query: payload.query,
        queryPlan: combined.queryPlan,
        publications: [...combined.publications, ...combined.openalexPublications],
        trials: combined.trials,
        pubmedPublications: combined.publications,
        openalexPublications: combined.openalexPublications,
        combined: [...combined.publications, ...combined.openalexPublications, ...combined.trials]
    };

    await persistIngestionRun(options.sessionId || "", payload, normalized.combined.length);

    return normalized;
}

module.exports = {
    ingestEvidence
};
