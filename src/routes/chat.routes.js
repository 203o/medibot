const express = require("express");

const { createTurn, createTurnStream } = require("../controllers/chat.controller");
const { asyncHandler } = require("../utils/async-handler");

const router = express.Router();

router.post("/turn", asyncHandler(createTurn));
router.post("/turn/stream", createTurnStream);

module.exports = router;
