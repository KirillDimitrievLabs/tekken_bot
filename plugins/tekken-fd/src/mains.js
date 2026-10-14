// Per-user main character (A1) and per-chat roster. Stored in <state>/mains.json.
import fs from "node:fs";

export class Mains {
  constructor(file) {
    this.file = file;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return { users: {} };
    }
  }

  save(data) {
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  get(userId) {
    return this.load().users[String(userId)]?.character ?? null;
  }

  /** Remember the main and that this user is seen in `chatId` (for !mains). */
  set(userId, character, { chatId, name } = {}) {
    const data = this.load();
    const u = (data.users[String(userId)] ??= { chats: [] });
    u.character = character;
    if (name) u.name = name;
    if (chatId && !u.chats.includes(String(chatId))) u.chats.push(String(chatId));
    u.at = new Date().toISOString();
    this.save(data);
  }

  clear(userId) {
    const data = this.load();
    if (data.users[String(userId)]) delete data.users[String(userId)].character;
    this.save(data);
  }

  /** Record that a user with a main was active in a chat (so they show up in that chat's roster). */
  seen(userId, chatId, name) {
    const data = this.load();
    const u = data.users[String(userId)];
    if (!u?.character) return;
    let dirty = false;
    if (chatId && !u.chats.includes(String(chatId))) {
      u.chats.push(String(chatId));
      dirty = true;
    }
    if (name && u.name !== name) {
      u.name = name;
      dirty = true;
    }
    if (dirty) this.save(data);
  }

  /** [{userId, name, character}] for a chat, grouped by character. */
  roster(chatId) {
    return Object.entries(this.load().users)
      .filter(([, u]) => u.character && u.chats?.includes(String(chatId)))
      .map(([userId, u]) => ({ userId, name: u.name ?? userId, character: u.character }))
      .sort((a, b) => a.character.localeCompare(b.character) || a.name.localeCompare(b.name));
  }
}
