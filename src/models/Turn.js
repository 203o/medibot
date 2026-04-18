const { mongoose } = require("../config/database");

let TurnModel;

if (mongoose) {
    const turnSchema = new mongoose.Schema(
        {
            sessionId: { type: String, required: true, index: true },
            turnId: { type: String, required: true, unique: true, index: true },
            role: { type: String, enum: ["user", "assistant"], required: true },
            message: { type: String, required: true },
            intent: { type: mongoose.Schema.Types.Mixed, default: {} },
            answer: { type: String, default: "" },
            evidenceIds: { type: [String], default: [] },
            sourceMapping: { type: [mongoose.Schema.Types.Mixed], default: [] },
            validation: { type: mongoose.Schema.Types.Mixed, default: {} },
            memorySnapshot: { type: mongoose.Schema.Types.Mixed, default: {} }
        },
        { timestamps: true }
    );

    TurnModel = mongoose.models.Turn || mongoose.model("Turn", turnSchema);
}

module.exports = TurnModel;
