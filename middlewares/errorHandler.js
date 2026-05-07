const { HttpError } = require("../utils/httpError");

function errorHandler(err, req, res, next) {
  const isHttp = err instanceof HttpError;
  const status = isHttp ? err.status : 500;

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({
    error: {
      message: isHttp ? err.message : "Internal server error",
      details: isHttp ? err.details : undefined
    }
  });
}

module.exports = { errorHandler };

