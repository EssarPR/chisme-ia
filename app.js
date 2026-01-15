require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
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

REGLAS ESTRICTAS:
1. USA la herramienta de búsqueda de Google para verificar información actual
2. NO uses conocimiento previo para hechos posteriores a enero 2025
3. Para CADA afirmación, cita la fuente con este formato EXACTO:
   [Fuente: Nombre del Medio - URL_COMPLETA_DEL_ARTICULO]
   Ejemplo: [Fuente: El País - https://elpais.com/internacional/2026-01-13/noticia.html]
4. Las URLs DEBEN ser direcciones web reales y completas que empiecen con http:// o https://
5. NO uses URLs internas de búsqueda como "vertexaisearch" o similares
6. Si no puedes obtener la URL real del artículo, usa la URL del sitio principal del medio
7. Si no encuentras información verificable, dilo explícitamente
8. Incluye fechas cuando estén disponibles

FORMATO DE RESPUESTA:
- Párrafos cortos y directos
- Resalta datos clave con **negritas**
- Termina con "🔍 FUENTES VERIFICADAS:" seguido de lista numerada con URLs REALES Y COMPLETAS

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

// --- RUTA 2: PORTADA DE NOTICIAS ---
app.get('/noticias-dia', async (req, res) => {
    // Verificar caché primero
    const cacheKey = 'noticias-dia';
    const cached = getCached(cacheKey);
    
    if (cached) {
        return res.json(cached);
    }

    try {
        const fechaHoy = new Date().toLocaleDateString('es-MX', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });

        // CORRECCIÓN: Sintaxis correcta según documentación
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: [
                { googleSearch: {} }  // CORRECCIÓN: Sintaxis correcta
            ],
            systemInstruction: `Eres un curador de noticias que DEBE buscar en Google las noticias de HOY.

FECHA DE HOY: ${fechaHoy}

PROCESO OBLIGATORIO:
1. Busca en Google noticias de las últimas 24 horas
2. Para cada categoría, busca noticias específicas actuales
3. VERIFICA que las URLs sean reales
4. Solo noticias de las últimas 24-48 horas

CATEGORÍAS (debes generar EXACTAMENTE 5 tarjetas):
- 🌍 Internacional
- 🇲🇽 Nacional México
- 🎭 Espectáculos
- 🎨 Cultura
- 🔬 Ciencia

FORMATO HTML EXACTO (copia este formato):
<div class="news-card">
  <span class="tag internacional">INTERNACIONAL</span>
  <h3 class="news-title">Título corto de máximo 60 caracteres</h3>
  <p class="news-summary">Resumen de 2 líneas máximo que explique la noticia.</p>
  <a href="https://url-completa-real.com" target="_blank" rel="noopener" class="source-btn">Ver noticia 🔗</a>
</div>

CLASES CSS válidas: "internacional", "nacional", "espectaculos", "cultura", "ciencia"

REGLAS:
- URLs completas con https://
- NO inventes URLs
- Si no encuentras noticia, busca con términos diferentes
- Devuelve SOLO el HTML, sin explicaciones`
        });

        const prompt = `Busca en Google y genera 5 tarjetas HTML de noticias actuales.

Fecha: ${fechaHoy}

Busca noticias verificables de medios reconocidos (El País, BBC, Reforma, CNN, El Universal, etc.) de las últimas 24-48 horas.`;

        const result = await model.generateContent(prompt);
        const respuestaTexto = result.response.text();
        
        // Limpiar respuesta
        let htmlLimpio = respuestaTexto
            .replace(/```html/gi, '')
            .replace(/```/g, '')
            .trim();

        // Validación: verificar tarjetas
        const numeroTarjetas = (htmlLimpio.match(/class="news-card"/g) || []).length;
        
        if (numeroTarjetas < 3) {
            throw new Error(`Solo se generaron ${numeroTarjetas} tarjetas`);
        }

        const response = { 
            html: htmlLimpio,
            fecha: fechaHoy,
            total: numeroTarjetas,
            cached: false
        };

        // Guardar en caché
        setCache(cacheKey, response);

        res.json(response);

    } catch (error) {
        console.error("❌ Error en noticias:", error.message);
        
        let errorMsg = "🚨 Error temporal al cargar noticias.";
        
        if (error.message.includes('429') || error.message.includes('quota')) {
            errorMsg = "⏳ Cuota de API agotada. Las noticias se actualizarán pronto.";
        }
        
        res.status(500).json({ 
            html: `<div class="error-card">
                <h3>${errorMsg}</h3>
                <p>Intenta de nuevo en unos minutos o usa la búsqueda manual.</p>
            </div>`,
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