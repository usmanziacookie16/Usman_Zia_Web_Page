const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { SYSTEM_PROMPT } = require('./persona');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // set to your site's URL in production
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
const VOICE = process.env.REALTIME_VOICE || 'alloy';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. /api/chat and /voice will fail until it is.');
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------- Text chat route ----------
// Body: { messages: [{ role: 'user'|'assistant', content: string }, ...] }
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI chat error:', errText);
      return res.status(502).json({ error: 'Upstream chat request failed' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content ?? '';
    res.json({ reply });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Server + WebSocket relay for the voice agent ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/voice' });

wss.on('connection', (clientSocket) => {
  console.log('Voice client connected');

  // Open a matching connection to OpenAI's Realtime API for this client.
  const upstream = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  upstream.on('open', () => {
    // Configure the session with the shared persona and a chosen voice.
    upstream.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: SYSTEM_PROMPT,
          voice: VOICE,
          modalities: ['audio', 'text'],
        },
      })
    );
  });

  // Relay messages both directions.
  clientSocket.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });
  upstream.on('message', (data) => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data);
  });

  const closeBoth = () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
  };

  clientSocket.on('close', closeBoth);
  upstream.on('close', closeBoth);
  clientSocket.on('error', (e) => console.error('Client socket error:', e.message));
  upstream.on('error', (e) => console.error('Upstream socket error:', e.message));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
