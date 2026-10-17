// Sandboxed file tools. Every path is jailed to the workspace root (incl. symlink checks).
import fs from 'node:fs/promises';
import path from 'node:path';
const SKIP = new Set(['node_modules', '.git', '.araina']);

export class Workspace {
  constructor(root) { this.root = path.resolve(root); }

  async safe(p = '') {
    const abs = path.resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error('Path escapes workspace');
    const rr = await fs.realpath(this.root);
    let probe = abs;
    while (true) { // resolve symlinks on the deepest existing ancestor
      try {
        const real = await fs.realpath(probe);
        if (real !== rr && !real.startsWith(rr + path.sep)) throw new Error('Symlink escapes workspace');
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const up = path.dirname(probe); if (up === probe) break; probe = up;
      }
    }
    return abs;
  }

  async list(dir = '', depth = 3) {
    const out = [];
    const walk = async (d, lvl) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(d, e.name), rel = path.relative(this.root, full);
        out.push({ path: rel, type: e.isDirectory() ? 'dir' : 'file' });
        if (e.isDirectory() && lvl < depth) await walk(full, lvl + 1);
      }
    };
    await walk(await this.safe(dir), 1);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(p) {
    const abs = await this.safe(p); const st = await fs.stat(abs);
    if (st.size > 1_000_000) throw new Error('File too large (>1MB)');
    return fs.readFile(abs, 'utf8');
  }

  // Saves the previous version as a recoverable checkpoint before overwriting.
  async write(p, content) {
    const abs = await this.safe(p); let before = null;
    try { before = await fs.readFile(abs, 'utf8'); } catch {}
    if (before !== null && before !== content) {
      const cp = path.join(this.root, '.araina', 'checkpoints', String(Date.now()), p);
      await fs.mkdir(path.dirname(cp), { recursive: true }); await fs.writeFile(cp, before);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return { path: p, created: before === null, bytes: Buffer.byteLength(content), changed: before !== content };
  }

  async search(query, max = 50) {
    const hits = [], q = query.toLowerCase();
    for (const f of await this.list('', 8)) {
      if (f.type !== 'file' || hits.length >= max) continue;
      let text; try { text = await this.read(f.path); } catch { continue; }
      text.split('\n').forEach((line, i) => { if (hits.length < max && line.toLowerCase().includes(q)) hits.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 200) }); });
    }
    return hits;
  }
}
