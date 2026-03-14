import { resolve } from 'node:path';
import type { ForgeEvent } from '../engine/events.js';
import { openDatabase, type MonitorDB } from './db.js';
import { withRecording } from './recorder.js';
import { startServer, type MonitorServer } from './server.js';

export type { MonitorDB } from './db.js';
export type { MonitorServer } from './server.js';
export { withRecording } from './recorder.js';

export interface Monitor {
  db: MonitorDB;
  server: MonitorServer;
  wrapEvents(events: AsyncGenerator<ForgeEvent>): AsyncGenerator<ForgeEvent>;
  stop(): Promise<void>;
}

export async function createMonitor(cwd: string, port?: number): Promise<Monitor> {
  const dbPath = resolve(cwd, '.forge', 'monitor.db');
  const db = openDatabase(dbPath);
  const server = await startServer(db, port);

  return {
    db,
    server,
    wrapEvents(events: AsyncGenerator<ForgeEvent>): AsyncGenerator<ForgeEvent> {
      return withRecording(events, db, cwd, (event, eventId) => server.pushEvent(event, eventId));
    },
    async stop(): Promise<void> {
      await server.stop();
      db.close();
    },
  };
}
