/**
 * clockworks — Scheduled hook (every minute). Polls Clockworks Analytics when the poll interval is
 * due (Settings → Poll every), carrying a large portfolio across several runs, and writes each
 * equipment's FDD values to the app's point layer. Does nothing until enabled in Settings.
 */
const C = require('../lib/clockworks');

module.exports = async () => {
  try { return JSON.stringify(await C.runPoll()); }
  catch (e) { return JSON.stringify({ error: e.message }); }
};
