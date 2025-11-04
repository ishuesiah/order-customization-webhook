// worker.js
// DUMMY FILE - NO LONGER USED
// 
// All worker functionality has been moved to server.js (combined webhook + worker)
// This file exists only to satisfy Kinsta's worker process configuration
// and prevent deployment failures.

console.log('═══════════════════════════════════════════════════════════════');
console.log('ℹ️  DUMMY WORKER PROCESS');
console.log('ℹ️  This file is intentionally empty');
console.log('ℹ️  All worker functionality is now in server.js');
console.log('═══════════════════════════════════════════════════════════════\n');

// Keep the process alive indefinitely without doing anything
// This prevents Kinsta from trying to restart it over and over
setInterval(() => {
  // Log once per hour just to show it's still running
  console.log('💤 Dummy worker still running (doing nothing) - server.js handles all work');
}, 60 * 60 * 1000);

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('Dummy worker received SIGTERM, exiting...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Dummy worker received SIGINT, exiting...');
  process.exit(0);
});

console.log('✅ Dummy worker started successfully (will do nothing)\n');
