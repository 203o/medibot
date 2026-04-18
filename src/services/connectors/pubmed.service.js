const { getCachedEvidence, setCachedEvidence } = require("../cache.service");

function buildPubMedQuery(intent) {
    const pieces = [
        intent.disease,
        intent.intent,
        intent.symptoms.join(" "),
        intent.location.normalized
    ].filter(Boolean);

    return pieces.join(" ");
}

function createPubMedUrl(path, params) {
    const url = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}`);
    Object.entries(params).forEach(([key, value]) => {
        if (value) {
            url.searchParams.set(key, value);
        }
    });
    return url.toString();
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": "medibot-grounded-backend"
        }
    });

    if (!response.ok) {
        throw new Error(`PubMed request failed with status ${response.status}`);
    }

    return response.json();
}

function normalizePubMedRecord(record) {
    return {
        id: String(record.uid),
        source: "pubmed",
        title: record.title || "Untitled publication",
        journal: record.fulljournalname || record.source || "PubMed",
        year: Number(String(record.pubdate || "").slice(0, 4)) || null,
        publishedAt: record.pubdate || "",
        authors: Array.isArray(record.authors) ? record.authors.map((author) => author.name).filter(Boolean) : [],
        url: `https://pubmed.ncbi.nlm.nih.gov/${record.uid}/`,
        snippet: record.title || "",
        studyType: Array.isArray(record.pubtype) ? record.pubtype.join(", ") : "Publication",
        raw: record
    };
}

async function searchPubMed(intent) {
    const query = buildPubMedQuery(intent);
    if (!query) {
        return [];
    }

    const cached = await getCachedEvidence("pubmed", query);
    if (cached) {
        return cached;
    }

    try {
        const searchUrl = createPubMedUrl("esearch.fcgi", {
            db: "pubmed",
            term: query,
            retmode: "json",
            retmax: "8",
            sort: "relevance",
            tool: process.env.PUBMED_TOOL,
            email: process.env.PUBMED_EMAIL
        });
        const searchJson = await fetchJson(searchUrl);
        const ids = searchJson?.esearchresult?.idlist || [];

        if (ids.length === 0) {
            return [];
        }

        const summaryUrl = createPubMedUrl("esummary.fcgi", {
            db: "pubmed",
            id: ids.join(","),
            retmode: "json",
            tool: process.env.PUBMED_TOOL,
            email: process.env.PUBMED_EMAIL
        });
        const summaryJson = await fetchJson(summaryUrl);
        const records = ids
            .map((id) => summaryJson?.result?.[id])
            .filter(Boolean)
            .map(normalizePubMedRecord);

        await setCachedEvidence("pubmed", query, records);
        return records;
    } catch (error) {
        console.warn("PubMed search failed:", error.message);
        return [];
    }
}

module.exports = {
    searchPubMed
};
