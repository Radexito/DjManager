import { beforeAll, afterEach } from 'vitest';
import { initDB } from '../db/migrations.js';
import db from '../db/database.js';

beforeAll(() => {
  initDB();
});

afterEach(() => {
  // Clear all data between tests for isolation
  db.prepare('DELETE FROM playlist_tracks').run();
  db.prepare('DELETE FROM playlists').run();
  db.prepare('DELETE FROM tracks').run();
  db.prepare('DELETE FROM settings').run();
});
