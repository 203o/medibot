const { mongoose } = require("../config/database");

let IngestionRunModel;

if (mongoose) {
    const ingestionRunSchema = new mongoose.Schema(
        {
            sessionId: { type: String, index: true, default: "" },
            runId: { type: String, required: true, unique: true, index: true },
            query: { type: String, required: true },
            sources: { type: [String], default: [] },
            outputDir: { type: String, required: true },
            manifestPath: { type: String, required: true },
            counts: {
                pubmed: { type: Number, default: 0 },
                clinicaltrials: { type: Number, default: 0 },
                openalex: { type: Number, default: 0 },
                combined: { type: Number, default: 0 }
            },
            status: { type: String, default: "completed" }
        },
        { timestamps: true }
    );

    IngestionRunModel = mongoose.models.IngestionRun || mongoose.model("IngestionRun", ingestionRunSchema);
}

module.exports = IngestionRunModel;
