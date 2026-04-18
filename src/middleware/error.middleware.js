function notFoundHandler(req, res) {
    res.status(404).json({
        error: "NotFound",
        message: `Route ${req.method} ${req.originalUrl} was not found`
    });
}

function errorHandler(error, _req, res, _next) {
    const status = error.status || 500;
    res.status(status).json({
        error: error.name || "ServerError",
        message: error.message || "Unexpected server error"
    });
}

module.exports = {
    notFoundHandler,
    errorHandler
};
