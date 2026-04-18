const store = {
    sessions: new Map(),
    memories: new Map(),
    turns: new Map(),
    evidenceCache: new Map(),
    ingestionRuns: new Map()
};

function getTurns(sessionId) {
    return store.turns.get(sessionId) || [];
}

function setTurns(sessionId, turns) {
    store.turns.set(sessionId, turns);
}

module.exports = {
    store,
    getTurns,
    setTurns
};
