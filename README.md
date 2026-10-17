# Araina AI (v0.1, Milestones 1-3)

Zero-dependency Node app (no npm install needed). Needs Node 20+.

## Termux
    pkg update && pkg install nodejs unzip
    unzip araina.zip && cd araina
    node server.mjs
Phone browser mein kholo: http://localhost:3000

## Gemini setup
Settings -> API key paste karo (https://aistudio.google.com se milti hai) -> Save -> model chuno -> Test connection.
Ya env: GEMINI_API_KEY=... GEMINI_MODEL=... node server.mjs
Key sirf server par rehti hai (.araina/secrets.json), browser ko sirf masked form milta hai.

## Kya kaam karta hai
Gemini streaming chat, tool-calling agent (list/read/write/search files), file explorer + editor,
write se pehle checkpoint (.araina/checkpoints), path-jail, 6 automated tests (`npm test`).

## Abhi NAHI bana (honest list)
Monaco editor (plain textarea hai), terminal/test runner tools, diagnostics + Fix Error, Git,
deployment (Vercel/Netlify etc.), voice, memory, Android build, sandbox, login/auth.
Server sirf 127.0.0.1 par chalta hai; bina auth/sandbox ke public internet par expose mat karna.
