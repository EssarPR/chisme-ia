require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const Parser = require('rss-parser');

const app = express();

/* ===============================
   CONFIGURACIÓN GENERAL
================================ */

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// RSS Parser (IMPORTANTE para Vercel)
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (NewsBot)'
  }
});

// Middlewares
app.use(express.json());
app.use(express.static('public'));

// Cache simple
const cache = new Map();
const CACHE_DURATION = 15 * 60 * 1000;

// Rate limit simple
const requestCounts = new Map();
const RATE_LIMIT = 50;
const RATE_WINDOW = 60 * 1000;

/* ===============================
   UTILIDADES
================================ */

function getCached(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

/* ===============================
   RATE LIMITING
================================ */

app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }

  const user = requestCounts.get(ip);

  if (now > user.resetTime) {
    user.count = 1;
    user.resetTime = now + RATE_WINDOW;
    return next();
  }

  if (user.count >= RATE_LIMIT) {
    return res.status(429).json({
      error: 'Demasiadas peticiones, intenta más tarde'
    });
  }

  user.count++;
  next();
});

/* ===============================
   RUTAS ESTÁTICAS
================================ */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/terminos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
});

app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.get('/acerca-de', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'acerca.html'));
});

/* ===============================
   IA - CHISME
================================ */

app.post('/chisme', async (req, res) => {
  const { pregunta } = req.body;

  if (!pregunta || !pregunta.trim()) {
    return res.status(400).json({ error: 'Pregunta vacía' });
  }

  const cacheKey = `chisme:${pregunta.toLowerCase()}`;
  const cached = getCached(cacheKey);

  if (cached) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(cached);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools: [{ googleSearch: {} }],
      systemInstruction: `
Eres un verificador de noticias profesional.
Responde de forma clara, neutral y basada en hechos actuales.
Fecha de hoy: ${new Date().toLocaleDateString('es-MX')}
`
    });

    const result = await model.generateContentStream(
      `Investiga en Google: "${pregunta}"`
    );

    let fullText = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        res.write(text);
      }
    }

    setCache(cacheKey, fullText);
    res.end();

  } catch (err) {
    console.error(err);
    res.end('\nError al consultar la IA');
  }
});

/* ===============================
   NOTICIAS DEL DÍA
================================ */

// --- RUTA 2: PORTADA DE NOTICIAS (REDISEÑADA) ---
app.get('/noticias-dia', async (req, res) => {
    const cacheKey = 'noticias-dia-v2';
    const cached = getCached(cacheKey);

    if (cached) {
        return res.json(cached);
    }

    try {
        const feedUrl = 'https://news.google.com/rss?hl=es-419&gl=MX&ceid=MX:es-419';
        const feed = await parser.parseURL(feedUrl);

        if (!feed.items || feed.items.length === 0) {
            throw new Error('Sin noticias disponibles');
        }

        // Filtrar noticias únicas por título
        const seenTitles = new Set();
        const uniqueNews = [];

        for (const item of feed.items) {
            const titleKey = item.title.toLowerCase().trim();
            if (!seenTitles.has(titleKey)) {
                seenTitles.add(titleKey);
                uniqueNews.push(item);
            }
            if (uniqueNews.length >= 5) break;
        }

        let htmlCards = '';

        uniqueNews.forEach(item => {
            const titulo = item.title;
            const resumen = item.contentSnippet
                ? item.contentSnippet.substring(0, 140) + '…'
                : 'Noticia reciente del día';
            const fuente = item.source?.title || 'Google News';

            htmlCards += `
            <article class="news-card">
              <div class="news-body">
                <h3 class="news-title">${titulo}</h3>
                <p class="news-summary">${resumen}</p>
                <div class="news-footer">
                  <span class="news-source">${fuente}</span>
                  <a href="${item.link}" target="_blank" rel="noopener" class="news-link">
                    Leer →
                  </a>
                </div>
              </div>
            </article>`;
        });

        const response = {
            html: htmlCards,
            fecha: new Date().toLocaleDateString('es-MX', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            }),
            total: uniqueNews.length,
            cached: false
        };

        setCache(cacheKey, response);
        res.json(response);

    } catch (error) {
        console.error('❌ Error noticias:', error.message);
        res.status(500).json({
            html: `<div class="error-card">
                     <h3>Noticias no disponibles</h3>
                     <p>Intenta nuevamente en unos minutos.</p>
                   </div>`,
            error: true
        });
    }
});


/* ===============================
   HEALTH
================================ */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache: cache.size,
    apiKey: process.env.GEMINI_API_KEY ? 'OK' : 'FALTA'
  });
});

/* ===============================
   ERRORES
================================ */

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

/* ===============================
   SERVER
================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en http://localhost:${PORT}`);
});

module.exports = app;
