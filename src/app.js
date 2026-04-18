const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const chatRoutes = require("./routes/chat.routes");
const sessionRoutes = require("./routes/session.routes");
const { errorHandler, notFoundHandler } = require("./middleware/error.middleware");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "medibot-grounded-backend",
        time: new Date().toISOString()
    });
});

app.use("/api/chat", chatRoutes);
app.use("/api/sessions", sessionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
