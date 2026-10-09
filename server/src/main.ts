import { startServer } from './index';

// one bad request or a bug in a handler must never take every match down with it: log and keep serving
process.on('uncaughtException', (err) => console.error('uncaught exception', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));

const port = Number(process.env.PORT) || 8080;
startServer({ port }).then((s) => {
  console.log(`arena server listening on :${s.port}  (ws path /ws, health /healthz)`);
  // a redeploy stops the server with SIGTERM: write the play time of everyone connected first
  process.once('SIGTERM', () => void s.close().finally(() => process.exit(0)));
});
