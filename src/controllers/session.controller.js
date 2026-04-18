const { getSessionBundle } = require("../services/memory.service");

async function getSession(req, res) {
    const bundle = await getSessionBundle(req.params.sessionId);
    res.json(bundle);
}

module.exports = {
    getSession
};
