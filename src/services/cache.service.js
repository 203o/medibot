const crypto = require("crypto");

const EvidenceCache = require("../models/EvidenceCache");
const { isMongoReady } = require("../config/database");
const { store } = require("./stores/in-memory.store");

function createCacheKey(source, query) {
    return crypto.createHash("sha1").update(`${source}:${query}`).digest("hex");
}

async function getCachedEvidence(source, query) {
    const cacheKey = createCacheKey(source, query);
    const now = Date.now();

    if (isMongoReady() && EvidenceCache) {
        const doc = await EvidenceCache.findOne({
            cacheKey,
            expiresAt: { $gt: new Date(now) }
        }).lean();

        return doc ? doc.payload : null;
    }

    const item = store.evidenceCache.get(cacheKey);
    if (!item || item.expiresAt < now) {
        return null;
    }

    return item.payload;
}

async function setCachedEvidence(source, query, payload, ttlMs = 1000 * 60 * 20) {
    const cacheKey = createCacheKey(source, query);
    const expiresAt = new Date(Date.now() + ttlMs);

    if (isMongoReady() && EvidenceCache) {
        await EvidenceCache.findOneAndUpdate(
            { cacheKey },
            {
                cacheKey,
                query,
                source,
                payload,
                fetchedAt: new Date(),
                expiresAt
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return;
    }

    store.evidenceCache.set(cacheKey, {
        payload,
        expiresAt: expiresAt.getTime()
    });
}

module.exports = {
    getCachedEvidence,
    setCachedEvidence
};
