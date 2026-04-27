const Session = require("../models/Session");
const Turn = require("../models/Turn");
const MedicalMemory = require("../models/MedicalMemory");
const { isMongoReady } = require("../config/database");
const { createId } = require("../utils/id");
const { store, getTurns, setTurns } = require("./stores/in-memory.store");

function createEmptyMemory(sessionId) {
    return {
        sessionId,
        conditions: [],
        intents: [],
        symptoms: [],
        substances: [],
        riskFlags: [],
        location: {
            raw: "",
            normalized: "",
            tokens: []
        },
        lastAnswerSummary: "",
        lastEvidenceIds: [],
        lastRetrievedIds: [],
        lastRetrievedEvidence: [],
        lastAnswerFocus: "",
        lastQueryFacets: {},
        activeCaseFrame: {}
    };
}

async function getSessionBundle(sessionId) {
    if (isMongoReady() && Session && MedicalMemory && Turn) {
        const [session, memory, turns] = await Promise.all([
            Session.findOne({ sessionId }).lean(),
            MedicalMemory.findOne({ sessionId }).lean(),
            Turn.find({ sessionId }).sort({ createdAt: 1 }).lean()
        ]);

        return {
            session: session || { sessionId },
            memory: memory || createEmptyMemory(sessionId),
            turns
        };
    }

    return {
        session: store.sessions.get(sessionId) || { sessionId },
        memory: store.memories.get(sessionId) || createEmptyMemory(sessionId),
        turns: getTurns(sessionId)
    };
}

async function saveUserTurn(sessionId, message, intent, memorySnapshot) {
    const turnId = createId("turn");

    if (isMongoReady() && Turn) {
        await Turn.create({
            sessionId,
            turnId,
            role: "user",
            message,
            intent,
            memorySnapshot
        });
        return turnId;
    }

    const turns = getTurns(sessionId);
    turns.push({
        sessionId,
        turnId,
        role: "user",
        message,
        intent,
        memorySnapshot,
        createdAt: new Date().toISOString()
    });
    setTurns(sessionId, turns);
    return turnId;
}

async function saveAssistantTurn(sessionId, answerPayload) {
    const turnId = createId("turn");

    if (isMongoReady() && Turn) {
        await Turn.create({
            sessionId,
            turnId,
            role: "assistant",
            message: answerPayload.answer,
            answer: answerPayload.answer,
            evidenceIds: answerPayload.evidenceIds,
            sourceMapping: answerPayload.sourceMapping,
            validation: answerPayload.validation,
            memorySnapshot: answerPayload.memorySnapshot
        });
        return turnId;
    }

    const turns = getTurns(sessionId);
    turns.push({
        sessionId,
        turnId,
        role: "assistant",
        message: answerPayload.answer,
        answer: answerPayload.answer,
        evidenceIds: answerPayload.evidenceIds,
        sourceMapping: answerPayload.sourceMapping,
        validation: answerPayload.validation,
        memorySnapshot: answerPayload.memorySnapshot,
        createdAt: new Date().toISOString()
    });
    setTurns(sessionId, turns);
    return turnId;
}

async function persistSessionState(sessionId, memory, summary) {
    const sessionPayload = {
        sessionId,
        lastMessage: summary.lastMessage || "",
        lastConfidence: summary.lastConfidence || "low",
        memorySnapshot: memory
    };

    if (isMongoReady() && Session && MedicalMemory) {
        await Promise.all([
            Session.findOneAndUpdate({ sessionId }, sessionPayload, { upsert: true, new: true, setDefaultsOnInsert: true }),
            MedicalMemory.findOneAndUpdate({ sessionId }, memory, { upsert: true, new: true, setDefaultsOnInsert: true })
        ]);
        return;
    }

    store.sessions.set(sessionId, sessionPayload);
    store.memories.set(sessionId, memory);
}

module.exports = {
    getSessionBundle,
    saveUserTurn,
    saveAssistantTurn,
    persistSessionState,
    createEmptyMemory
};
