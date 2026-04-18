const { mongoose } = require("../config/database");

let MedicalMemoryModel;

if (mongoose) {
    const medicalMemorySchema = new mongoose.Schema(
        {
            sessionId: { type: String, required: true, unique: true, index: true },
            conditions: { type: [String], default: [] },
            intents: { type: [String], default: [] },
            symptoms: { type: [String], default: [] },
            substances: { type: [String], default: [] },
            riskFlags: { type: [String], default: [] },
            location: {
                raw: { type: String, default: "" },
                normalized: { type: String, default: "" },
                tokens: { type: [String], default: [] }
            },
            lastAnswerSummary: { type: String, default: "" },
            lastEvidenceIds: { type: [String], default: [] },
            lastRetrievedIds: { type: [String], default: [] },
            lastRetrievedEvidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
            lastAnswerFocus: { type: String, default: "" },
            lastQueryFacets: { type: mongoose.Schema.Types.Mixed, default: {} }
        },
        { timestamps: true }
    );

    MedicalMemoryModel = mongoose.models.MedicalMemory || mongoose.model("MedicalMemory", medicalMemorySchema);
}

module.exports = MedicalMemoryModel;
