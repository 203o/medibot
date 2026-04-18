const { mongoose } = require("../config/database");

let EvidenceCacheModel;

if (mongoose) {
    const evidenceCacheSchema = new mongoose.Schema(
        {
            cacheKey: { type: String, required: true, unique: true, index: true },
            query: { type: String, required: true },
            source: { type: String, required: true },
            payload: { type: [mongoose.Schema.Types.Mixed], default: [] },
            fetchedAt: { type: Date, default: Date.now },
            expiresAt: { type: Date, required: true, index: true }
        },
        { timestamps: true }
    );

    EvidenceCacheModel = mongoose.models.EvidenceCache || mongoose.model("EvidenceCache", evidenceCacheSchema);
}

module.exports = EvidenceCacheModel;
