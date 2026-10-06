import { startServer } from './index';

const port = Number(process.env.PORT) || 8080;
startServer({ port }).then((s) => console.log(`arena server listening on :${s.port}  (ws path /ws, health /healthz)`));
