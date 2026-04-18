const { getCachedEvidence, setCachedEvidence } = require("../cache.service");

function buildTrialsQuery(intent) {
    const parts = [
        intent.disease,
        intent.intent,
        intent.symptoms.join(" "),
        intent.location.normalized
    ].filter(Boolean);

    return parts.join(" ");
}

function createTrialsUrl(intent) {
    const url = new URL("https://clinicaltrials.gov/api/v2/studies");
    const query = buildTrialsQuery(intent);

    if (query) {
        url.searchParams.set("query.term", query);
    }

    if (intent.location.tokens.includes("kenya")) {
        url.searchParams.set("query.locn", "Kenya");
    }

    url.searchParams.set("pageSize", "8");
    url.searchParams.set("format", "json");
    return url.toString();
}

function extractLocationCountries(study) {
    const countries = study?.protocolSection?.contactsLocationsModule?.locations
        ?.map((location) => location?.country)
        .filter(Boolean);

    return [...new Set(countries || [])];
}

function normalizeTrialRecord(study) {
    const identification = study?.protocolSection?.identificationModule || {};
    const description = study?.protocolSection?.descriptionModule || {};
    const design = study?.protocolSection?.designModule || {};
    const status = study?.protocolSection?.statusModule || {};

    return {
        id: identification.nctId || "unknown-trial",
        source: "clinicaltrials",
        title: identification.briefTitle || identification.officialTitle || "Untitled trial",
        journal: "ClinicalTrials.gov",
        year: Number(String(status?.startDateStruct?.date || "").slice(0, 4)) || null,
        publishedAt: status?.lastUpdateSubmitDate || status?.studyFirstSubmitDate || "",
        authors: [],
        url: `https://clinicaltrials.gov/study/${identification.nctId}`,
        snippet: description.briefSummary || description.detailedDescription || identification.briefTitle || "",
        studyType: [design.studyType, ...(design.phases || [])].filter(Boolean).join(", ") || "Clinical trial",
        locations: extractLocationCountries(study),
        raw: study
    };
}

async function searchClinicalTrials(intent) {
    const query = buildTrialsQuery(intent);
    if (!query) {
        return [];
    }

    const cached = await getCachedEvidence("clinicaltrials", query);
    if (cached) {
        return cached;
    }

    try {
        const response = await fetch(createTrialsUrl(intent), {
            headers: {
                "User-Agent": "medibot-grounded-backend"
            }
        });

        if (!response.ok) {
            throw new Error(`ClinicalTrials request failed with status ${response.status}`);
        }

        const json = await response.json();
        const studies = Array.isArray(json?.studies) ? json.studies.map(normalizeTrialRecord) : [];
        await setCachedEvidence("clinicaltrials", query, studies);
        return studies;
    } catch (error) {
        console.warn("ClinicalTrials search failed:", error.message);
        return [];
    }
}

module.exports = {
    searchClinicalTrials
};
