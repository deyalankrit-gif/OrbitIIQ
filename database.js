"use strict";

const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");

const DEFAULT_DATABASE_PATH = path.join(__dirname, "data", "OrbitIQ.sqlite");

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
  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      mode TEXT NOT NULL,
      profile_json TEXT,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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

    claimBrowserState(browserId) {
      const state = this.get(browserId);
      if (!state) return null;
      database.run("DELETE FROM browser_state WHERE browser_id = ?", [browserId]);
      writeFile();
      return state;
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

    getUserByEmail(email) {
      const statement = database.prepare(
        "SELECT id, email, profile_json, created_at, verified_at FROM users WHERE email = ? COLLATE NOCASE"
      );
      try {
        statement.bind([email]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return { ...row, profile: JSON.parse(row.profile_json) };
      } finally {
        statement.free();
      }
    },

    getUserById(userId) {
      const statement = database.prepare(
        "SELECT id, email, profile_json, created_at, verified_at FROM users WHERE id = ?"
      );
      try {
        statement.bind([userId]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return { ...row, profile: JSON.parse(row.profile_json) };
      } finally {
        statement.free();
      }
    },

    createUser(id, email, profile) {
      const verifiedAt = new Date().toISOString();
      database.run(
        "INSERT INTO users (id, email, profile_json, created_at, verified_at) VALUES (?, ?, ?, ?, ?)",
        [id, email, JSON.stringify(profile), verifiedAt, verifiedAt]
      );
      writeFile();
      return { id, email, profile, created_at: verifiedAt, verified_at: verifiedAt };
    },

    updateUserProfile(userId, profile) {
      database.run("UPDATE users SET profile_json = ? WHERE id = ?", [JSON.stringify(profile), userId]);
      writeFile();
    },

    saveVerificationCode(email, record) {
      database.run(
        `INSERT INTO verification_codes (email, code_hash, salt, mode, profile_json, expires_at, attempts, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(email) DO UPDATE SET
           code_hash = excluded.code_hash,
           salt = excluded.salt,
           mode = excluded.mode,
           profile_json = excluded.profile_json,
           expires_at = excluded.expires_at,
           attempts = 0,
           sent_at = excluded.sent_at`,
        [email, record.hash, record.salt, record.mode, record.profile ? JSON.stringify(record.profile) : null, record.expiresAt, record.sentAt]
      );
      writeFile();
    },

    getVerificationCode(email) {
      const statement = database.prepare(
        "SELECT code_hash, salt, mode, profile_json, expires_at, attempts, sent_at FROM verification_codes WHERE email = ? COLLATE NOCASE"
      );
      try {
        statement.bind([email]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return {
          hash: row.code_hash,
          salt: row.salt,
          mode: row.mode,
          profile: row.profile_json ? JSON.parse(row.profile_json) : null,
          expiresAt: row.expires_at,
          attempts: row.attempts,
          sentAt: row.sent_at
        };
      } finally {
        statement.free();
      }
    },

    incrementVerificationAttempts(email) {
      database.run("UPDATE verification_codes SET attempts = attempts + 1 WHERE email = ? COLLATE NOCASE", [email]);
      writeFile();
    },

    deleteVerificationCode(email) {
      database.run("DELETE FROM verification_codes WHERE email = ? COLLATE NOCASE", [email]);
      writeFile();
    },

    createSession(tokenHash, userId, expiresAt) {
      database.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [tokenHash, userId, expiresAt]);
      writeFile();
    },

    getSession(tokenHash, now = Date.now()) {
      const statement = database.prepare(
        `SELECT sessions.user_id, sessions.expires_at, users.id, users.email, users.profile_json
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
      );
      try {
        statement.bind([tokenHash, now]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return {
          user: { id: row.id, email: row.email, profile: JSON.parse(row.profile_json) },
          expiresAt: row.expires_at
        };
      } finally {
        statement.free();
      }
    },

    deleteSession(tokenHash) {
      database.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
      writeFile();
    },

    getUserState(userId) {
      const statement = database.prepare("SELECT data_json, updated_at FROM user_state WHERE user_id = ?");
      try {
        statement.bind([userId]);
        if (!statement.step()) return null;
        const row = statement.getAsObject();
        return { data: JSON.parse(row.data_json), updatedAt: row.updated_at };
      } finally {
        statement.free();
      }
    },

    saveUserState(userId, data) {
      database.run(
        `INSERT INTO user_state (user_id, data_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(data), new Date().toISOString()]
      );
      writeFile();
    },

    close() {
      database.close();
    }
  };
}

module.exports = { openDatabase };
