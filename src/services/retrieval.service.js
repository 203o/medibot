const { ingestEvidence } = require("./ingestion.service");
const { searchPubMed } = require("./connectors/pubmed.service");
const { searchClinicalTrials } = require("./connectors/trials.service");

async function retrieveEvidence(intent, options = {}) {
    if (String(intent?.retrievalMode || "").toLowerCase() === "greeting") {
        return {
            source: "guardrail_skip",
            ingestion: null,
            publications: [],
            pubmedPublications: [],
            openalexPublications: [],
            trials: [],
            combined: []
        };
    }

    try {
        const ingested = await ingestEvidence(intent, options);
        return {
            source: "fastapi_ingestion",
            ingestion: {
                runId: ingested.runId,
                outputDir: ingested.outputDir,
                manifestPath: ingested.manifestPath,
                query: ingested.query,
                queryPlan: ingested.queryPlan || null
            },
            publications: ingested.publications,
            pubmedPublications: ingested.pubmedPublications || ingested.publications,
            openalexPublications: ingested.openalexPublications || [],
            trials: ingested.trials,
            combined: ingested.combined
        };
    } catch (error) {
        console.warn("FastAPI ingestion unavailable, falling back to direct retrieval.");
        console.warn(error.message);
    }

    const [publications, trials] = await Promise.all([
        searchPubMed(intent),
        searchClinicalTrials(intent)
    ]);

    return {
        source: "direct_connectors",
        ingestion: null,
        publications,
        pubmedPublications: publications,
        openalexPublications: [],
        trials,
        combined: [...publications, ...trials]
    };
}

module.exports = {
    retrieveEvidence
};
