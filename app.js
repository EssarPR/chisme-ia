require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const axios = require('axios');
const app = express();

// CORRECCIÓN: Usar la clase correcta del SDK oficial
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static('public'));

// Sistema de caché simple para evitar agotar la cuota
const cache = new Map();
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutos

// Rate limiting por IP
const requestCounts = new Map();
const RATE_LIMIT = 5; // 5 peticiones
const RATE_WINDOW = 60 * 1000; // por minuto

// Funciones de caché
function getCached(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log(`✅ Cache hit para: ${key}`);
        return cached.data;
    }
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
    console.log(`💾 Guardado en cache: ${key}`);
}

// Middleware de rate limiting
app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
        return next();
    }
    
    const userData = requestCounts.get(ip);
    
    if (now > userData.resetTime) {
        userData.count = 1;
        userData.resetTime = now + RATE_WINDOW;
        return next();
    }
    
    if (userData.count >= RATE_LIMIT) {
        return res.status(429).json({ 
            error: "⏳ Demasiadas peticiones. Espera un minuto.",
            retryAfter: Math.ceil((userData.resetTime - now) / 1000)
        });
    }
    
    userData.count++;
    next();
});

// --- RUTA 0: PÁGINA PRINCIPAL (HOMEPAGE) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- RUTA 1: INVESTIGACIÓN CON STREAMING ---
app.post('/chisme', async (req, res) => {
    const { pregunta } = req.body;
    
    if (!pregunta || pregunta.trim().length === 0) {
        return res.status(400).json({ error: "❌ Necesito que me digas qué investigar" });
    }

    // Verificar caché primero
    const cacheKey = `chisme:${pregunta.toLowerCase().trim()}`;
    const cached = getCached(cacheKey);
    
    if (cached) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.write(cached);
        return res.end();
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // CORRECCIÓN: Sintaxis correcta según la documentación oficial
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash", // Modelo estable con mejor cuota
            tools: [
                { googleSearch: {} }  // CORRECCIÓN: Sintaxis correcta para Google Search
            ],
            systemInstruction: `Eres un verificador de noticias profesional con acceso a búsqueda en tiempo real.

REGLAS DE REDACCIÓN:
1. USA la herramienta de búsqueda de Google para verificar información actual
2. NO uses conocimiento previo para hechos posteriores a enero 2025
3. Redacta la información de forma FLUIDA y NATURAL, sin interrumpir con citas
4. NO incluyas links ni referencias dentro de los párrafos
5. Resalta datos clave con **negritas**
6. Escribe en párrafos cortos y claros

ESTRUCTURA DE RESPUESTA:
1. Escribe 2-4 párrafos con la información verificada (SIN citas en medio del texto)
2. Después, al final, agrega la sección:

🔍 FUENTES VERIFICADAS:
1. Nombre del Medio - enlace
2. Nombre del Medio - enlace
3. Nombre del Medio - enlace

EJEMPLO DE FORMATO CORRECTO:

Sabine Moussier ha reaparecido en redes sociales y su hija Camila Peralta ha confirmado que se encuentra bien. La actriz ha hablado públicamente sobre su diagnóstico de neuropatía de fibras pequeñas, una enfermedad autoinmune que está tratando actualmente.

Ella misma ha pedido que cesen los rumores sobre su supuesta muerte o eutanasia, destacando las consecuencias negativas que esto tiene para sus seres queridos.

🔍 FUENTES VERIFICADAS:
1. Univision
2. Tvazteca
3. Crhoy
4. Las Estrellas

Fecha de hoy: ${new Date().toLocaleDateString('es-MX', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
})}`
        });

        const prompt = `Investiga usando búsqueda de Google: "${pregunta}"

IMPORTANTE: Busca activamente esta información actual en Google.`;

        const result = await model.generateContentStream(prompt);

        let fullText = '';
        let hasContent = false;

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                hasContent = true;
                fullText += chunkText;
                res.write(chunkText);
            }
        }

        if (!hasContent) {
            const fallback = "⚠️ No se pudo obtener información verificable sobre este tema.";
            res.write(fallback);
            fullText = fallback;
        }

        // Guardar en caché
        setCache(cacheKey, fullText);
        
        res.end();

    } catch (error) {
        console.error("❌ Error en streaming:", error.message);
        
        if (error.message.includes('429') || error.message.includes('quota')) {
            res.write("\n\n⏳ Cuota de API agotada. Intenta de nuevo en unos minutos.");
        } else {
            res.write("\n\n🚨 Error al conectar con la central de verificación.");
        }
        res.end();
    }
});


// --- RUTA 2: PORTADA DE NOTICIAS CON NEWSAPI ---
app.get('/noticias-dia', async (req, res) => {
    const cacheKey = 'noticias-dia';
    const cached = getCached(cacheKey);
    
    if (cached) {
        return res.json(cached);
    }

    try {
        // Fetch noticias de NewsAPI
        const newsResponse = await axios.get('https://newsapi.org/v2/top-headlines', {
            params: {
                country: 'mx',
                pageSize: 10,
                apiKey: process.env.NEWS_API_KEY
            }
        });

        const articles = newsResponse.data.articles;
        
        // Categorizar noticias
        const categorias = {
            internacional: articles.slice(0, 2),
            nacional: articles.slice(2, 4),
            espectaculos: articles.slice(4, 6),
            cultura: articles.slice(6, 8),
            ciencia: articles.slice(8, 10)
        };

        // Generar HTML
        let htmlCards = '';
        
        for (const [categoria, arts] of Object.entries(categorias)) {
            if (arts.length > 0) {
                const art = arts[0];
                const tagName = categoria.toUpperCase();
                const imagen = art.urlToImage || 'https://via.placeholder.com/400x200/667eea/ffffff?text=Sin+Imagen';
                const titulo = art.title.substring(0, 70);
                const resumen = art.description ? art.description.substring(0, 120) + '...' : 'Sin descripción';
                
                htmlCards += `
                <div class="news-card ${categoria}">
                  <img src="${imagen}" alt="${titulo}" class="news-image" onerror="this.src='https://via.placeholder.com/400x200/667eea/ffffff?text=Sin+Imagen'">
                  <div class="news-content">
                    <span class="tag ${categoria}">${tagName}</span>
                    <h3 class="news-title">${titulo}</h3>
                    <p class="news-summary">${resumen}</p>
                    <a href="${art.url}" target="_blank" rel="noopener" class="source-btn">${art.source.name} 🔗</a>
                  </div>
                </div>`;
            }
        }

        const response = { 
            html: htmlCards,
            fecha: new Date().toLocaleDateString('es-MX'),
            total: 5,
            cached: false
        };

        setCache(cacheKey, response);
        res.json(response);

    } catch (error) {
        console.error("❌ Error en noticias:", error.message);
        res.status(500).json({ 
            html: `<div class="error-card"><h3>Error temporal</h3><p>Intenta de nuevo.</p></div>`,
            error: true
        });
    }
});

// --- RUTA 3: HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online',
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash',
        apiKey: process.env.GEMINI_API_KEY ? 'configurada ✅' : 'faltante ❌',
        cacheSize: cache.size,
        rateLimitIPs: requestCounts.size
    });
});

// --- RUTA 4: LIMPIAR CACHÉ ---
app.post('/clear-cache', (req, res) => {
    cache.clear();
    requestCounts.clear();
    res.json({ message: 'Caché limpiado exitosamente' });
});

// --- MANEJO DE ERRORES GLOBAL ---
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

// --- ENCENDIDO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("═══════════════════════════════════════════");
    console.log("🚀 CHISME IA: PORTAL DE NOTICIAS ACTIVO");
    console.log(`👉 Servidor: http://localhost:${PORT}`);
    console.log(`📊 Health: http://localhost:${PORT}/health`);
    console.log(`🔑 API Key: ${process.env.GEMINI_API_KEY ? '✅' : '❌ FALTANTE'}`);
    console.log(`📅 Fecha: ${new Date().toLocaleString('es-MX')}`);
    console.log("═══════════════════════════════════════════");
});

// IMPORTANTE: Exportar para Vercel
module.exports = app;