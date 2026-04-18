const { mongoose } = require("../config/database");

let SessionModel;

if (mongoose) {
    const sessionSchema = new mongoose.Schema(
        {
            sessionId: { type: String, required: true, unique: true, index: true },
            lastMessage: { type: String, default: "" },
            lastConfidence: { type: String, default: "low" },
            memorySnapshot: { type: mongoose.Schema.Types.Mixed, default: {} }
        },
        { timestamps: true }
    );

    SessionModel = mongoose.models.Session || mongoose.model("Session", sessionSchema);
}

module.exports = SessionModel;
