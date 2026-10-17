// Tool-calling loop: model -> tool calls -> real execution -> results fed back -> repeat.
export const SYSTEM = `You are Araina, a warm, capable female AI software engineer. Reply in the user's language (Hindi, Hinglish or English).
You work ONLY through the provided tools on a real workspace. Inspect files before editing (list_files, read_file, search_code), then write_file with COMPLETE file contents.
Never claim you ran, built, tested or deployed anything you did not do with a tool. If you cannot verify something, say so.`;

export const TOOLS = [
  { name: 'list_files', description: 'List files/folders in the workspace', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Subfolder, default root' } } } },
  { name: 'read_file', description: 'Read a text file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a file with full contents', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'search_code', description: 'Case-insensitive text search across the workspace', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

export async function runTool(ws, name, a = {}) {
  try {
    if (name === 'list_files') return { files: await ws.list(a.path || '') };
    if (name === 'read_file') return { content: await ws.read(a.path) };
    if (name === 'write_file') return await ws.write(a.path, a.content ?? '');
    if (name === 'search_code') return { hits: await ws.search(a.query) };
    return { error: `Unknown tool ${name}` };
  } catch (e) { return { error: e.message }; }
}

export async function runAgent({ gemini, ws, history, emit, maxSteps = 8 }) {
  const contents = [...history];
  for (let step = 0; step < maxSteps; step++) {
    const modelParts = [];
    for await (const ev of gemini.stream(contents, { system: SYSTEM, tools: TOOLS })) {
      if (ev.usage) emit({ type: 'usage', usage: ev.usage });
      for (const p of ev.parts || []) { modelParts.push(p); if (p.text && !p.thought) emit({ type: 'text', text: p.text }); }
    }
    contents.push({ role: 'model', parts: modelParts }); // raw parts preserved (thought signatures)
    const calls = modelParts.filter(p => p.functionCall);
    if (!calls.length) return contents;
    const responses = [];
    for (const { functionCall: fc } of calls) {
      const result = await runTool(ws, fc.name, fc.args);
      emit({ type: 'tool', name: fc.name, ok: !result.error, summary: result.error || (fc.name === 'write_file' ? `${result.created ? 'created' : 'updated'} ${result.path}` : 'ok') });
      responses.push({ functionResponse: { name: fc.name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  emit({ type: 'text', text: '\n\n(Stopped: step limit reached. Ask me to continue.)' });
  return contents;
}
