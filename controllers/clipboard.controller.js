const { z } = require('zod');
const { analyzeClipboardText } = require('../services/clipboardAi.service');

const clipboardAnalyzeSchema = z.object({
  text: z.string().trim().min(1, 'Clipboard text is required').max(6000)
});

async function analyzeClipboard(req, res, next) {
  try {
    const input = clipboardAnalyzeSchema.parse(req.body || {});
    const analysis = await analyzeClipboardText(input);
    return res.json(analysis);
  } catch (err) {
    return next(err);
  }
}

module.exports = { analyzeClipboard };