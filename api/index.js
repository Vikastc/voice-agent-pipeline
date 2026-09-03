// Vercel entry point: expose the Express app as the /api/* serverless function.
// (vercel.json rewrites /api/* to this function; static files come from public/.)
module.exports = require('../server');
