// Worker threads do not inherit tsx's TypeScript loader, so register it here before loading the real worker.
import { register } from 'tsx/esm/api';

register();
await import('./learnWorker.ts');
