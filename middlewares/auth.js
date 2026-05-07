const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { HttpError } = require("../utils/httpError");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, "Unauthorized"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    req.auth = payload;
    return next();
  } catch {
    return next(new HttpError(401, "Unauthorized"));
  }
}

module.exports = { authRequired };

