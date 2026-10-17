// Gemini REST adapter (Gemini API). Model is user-configured, never hardcoded.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export class GeminiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export class Gemini {
  constructor(config, { fetchImpl = fetch, timeoutMs = 60_000, retries = 2 } = {}) { Object.assign(this, { config, fetchImpl, timeoutMs, retries }); }

  async #req(url, init, attempt = 0) {
    if (!this.config.apiKey) throw new GeminiError('Gemini API key is not configured', 401);
    let res;
    try { res = await this.fetchImpl(url, { ...init, headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey }, signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch (e) { throw new GeminiError(e.name === 'TimeoutError' ? 'Gemini request timed out' : 'Network error reaching Gemini', 0); }
    if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
      await new Promise(r => setTimeout(r, wait)); return this.#req(url, init, attempt + 1);
    }
    if (!res.ok) {
      let msg = res.statusText; try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new GeminiError(`Gemini API ${res.status}: ${msg}`, res.status);
    }
    return res;
  }

  async listModels() {
    const j = await (await this.#req(`${BASE}/models?pageSize=200`, { method: 'GET' })).json();
    return (j.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }));
  }

  // Yields { parts } (raw model parts, incl. thought signatures) and { usage }
  async *stream(contents, { system, tools } = {}) {
    if (!this.config.model) throw new GeminiError('No Gemini model selected. Choose one in Settings.', 400);
    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools?.length) body.tools = [{ functionDeclarations: tools }];
    const res = await this.#req(`${BASE}/models/${encodeURIComponent(this.config.model)}:streamGenerateContent?alt=sse`, { method: 'POST', body: JSON.stringify(body) });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const parts = j.candidates?.[0]?.content?.parts || [];
        if (parts.length) yield { parts };
        if (j.usageMetadata) yield { usage: j.usageMetadata };
      }
    }
  }
}
