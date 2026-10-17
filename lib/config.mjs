// Server-side secret storage. The key never leaves the server; clients only see a masked form.
import fs from 'node:fs/promises';
import path from 'node:path';
export class Config {
  constructor(dir) { this.file = path.join(dir, 'secrets.json'); this.data = {}; }
  async load() { try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { this.data = {}; } return this; }
  async save() { await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.writeFile(this.file, JSON.stringify(this.data), { mode: 0o600 }); }
  get apiKey() { return process.env.GEMINI_API_KEY || this.data.apiKey || ''; }
  get model() { return process.env.GEMINI_MODEL || this.data.model || ''; }
  async set({ apiKey, model }) { if (apiKey) this.data.apiKey = apiKey.trim(); if (model !== undefined) this.data.model = model.trim(); await this.save(); }
  async clearKey() { delete this.data.apiKey; await this.save(); }
  public() {
    const k = this.apiKey;
    return { hasKey: !!k, masked: k ? '••••' + k.slice(-4) : '', source: process.env.GEMINI_API_KEY ? 'environment' : k ? 'settings' : null, model: this.model };
  }
}
export const redact = (s, key) => (key ? String(s).split(key).join('[redacted]') : String(s));
