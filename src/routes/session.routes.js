const express = require("express");

const { getSession } = require("../controllers/session.controller");
const { asyncHandler } = require("../utils/async-handler");

const router = express.Router();

router.get("/:sessionId", asyncHandler(getSession));

module.exports = router;
