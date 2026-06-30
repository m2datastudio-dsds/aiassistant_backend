const express = require('express');
const { authRequired } = require('../middlewares/auth');
const { analyzeClipboard } = require('../controllers/clipboard.controller');

const clipboardRoutes = express.Router();

clipboardRoutes.use(authRequired);
clipboardRoutes.post('/analyze', analyzeClipboard);

module.exports = { clipboardRoutes };