"use strict";

const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");

const DEFAULT_DATABASE_PATH = path.join(__dirname, "data", "studyorbit.sqlite");

async function openDatabase(databasePath = process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH) {
  const resolvedPath = path.isAbsolute(databasePath)
    ? databasePath
    : path.resolve(__dirname, databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js")), file)
  });
  const database = fs.existsSync(resolvedPath)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(resolvedPath)))
    : new SQL.Database();

  database.run(`
    CREATE TABLE IF NOT EXISTS browser_state (
      browser_id TEXT PRIMARY KEY,
      profile_json TEXT,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const writeFile = () => {
    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, Buffer.from(database.export()));
      fs.renameSync(temporaryPath, resolvedPath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error("Could not remove incomplete database snapshot.", cleanupError);
      }
      throw error;
    }
  };

  if (!fs.existsSync(resolvedPath)) writeFile();

  return {
    get(browserId) {
      const statement = database.prepare(
        "SELECT profile_json, data_json, updated_at FROM browser_state WHERE browser_id = ?"
      );
      try {
        statement.bind([browserId]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return {
          profile: row.profile_json === null ? null : JSON.parse(row.profile_json),
          data: JSON.parse(row.data_json),
          updatedAt: row.updated_at
        };
      } finally {
        statement.free();
      }
    },

    save(browserId, profile, data) {
      database.run(
        `INSERT INTO browser_state (browser_id, profile_json, data_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(browser_id) DO UPDATE SET
           profile_json = excluded.profile_json,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`,
        [
          browserId,
          profile === null ? null : JSON.stringify(profile),
          JSON.stringify(data),
          new Date().toISOString()
        ]
      );
      writeFile();
    },

    close() {
      database.close();
    }
  };
}

module.exports = { openDatabase };
