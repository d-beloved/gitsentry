// TODO (Phase 3): Replace inline async processing with a Bull job queue.
//
// When a webhook arrives, instead of awaiting analyzeCode() inline, enqueue
// a job so the webhook handler can ack GitHub in <500ms regardless of diff size.
//
// Queue name: 'scan'
// Job payload: { scanId, diff, context, repoFullName, prNumber?, commitSha? }
//
// Example setup:
//   const Queue = require('bull');
//   const scanQueue = new Queue('scan', process.env.REDIS_URL);
//   scanQueue.process(require('./workers/scanWorker'));
//   module.exports = { scanQueue };

module.exports = {};
