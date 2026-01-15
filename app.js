require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const app = express();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static('public'));

// Sistema de caché
const cache = new Map();
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutos

// Rate limiting por IP
const requestCounts = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000;

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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- RUTA 1: INVESTIGACIÓN CON STREAMING ---
app.post('/chisme', async (req, res) => {
    const { pregunta } = req.body;
    
    if (!pregunta || pregunta.trim().length === 0) {
        return res.status(400).json({ error: "❌ Necesito que me digas qué investigar" });
    }

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
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: [
                { googleSearch: {} }
            ],
            systemInstruction: `Eres un verificador de noticias profesional con acceso a búsqueda en tiempo real de Google.

PROCESO OBLIGATORIO AL USAR GOOGLE SEARCH:
1. La herramienta de búsqueda de Google te devuelve resultados con URLs específicas de artículos
2. DEBES extraer y usar esas URLs EXACTAS en tus citas
3. Cada resultado incluye: título del artículo, descripción, y URL completa
4. Copia la URL COMPLETA tal como te la da Google, sin modificarla

FORMATO DE CITACIÓN OBLIGATORIO:
Después de cada afirmación o dato, cita así:
[Fuente: Nombre del Medio - URL_COMPLETA_DEL_ARTICULO]

Ejemplos CORRECTOS:
✅ [Fuente: El País - https://elpais.com/internacional/2026-01-13/venezuela-crisis-maduro.html]
✅ [Fuente: BBC News - https://www.bbc.com/mundo/noticias-internacional-68123456]
✅ [Fuente: CNN - https://cnnespanol.cnn.com/2026/01/13/economia-inflacion/]

Ejemplos INCORRECTOS:
❌ [Fuente: El País - https://elpais.com]
❌ [Fuente: BBC - www.bbc.com]
❌ [Fuente: Vertexaisearch]

REGLAS CRÍTICAS:
1. NO uses tu conocimiento previo para hechos después de enero 2025 - SIEMPRE busca
2. CADA afirmación específica DEBE tener su fuente con URL del artículo exacto
3. Si Google no te da la URL específica del artículo, NO inventes la cita
4. Resalta datos clave con **negritas**
5. Incluye fechas de publicación cuando las tengas

ESTRUCTURA DE RESPUESTA:
1. Resumen breve del tema (2-3 líneas)
2. Datos verificados con sus fuentes específicas
3. Al final: "🔍 FUENTES VERIFICADAS:" con lista numerada de URLs completas

Fecha de hoy: ${new Date().toLocaleDateString('es-MX', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
})}`
        });

        const prompt = `Busca información ACTUAL en Google sobre: "${pregunta}"

INSTRUCCIONES ESPECÍFICAS:
1. Usa la herramienta de búsqueda de Google
2. Extrae las URLs EXACTAS de los artículos que encuentres
3. Cita cada fuente con su URL completa del artículo específico
4. NO uses URLs genéricas de portadas de medios

Investiga y verifica esta información con fuentes actuales.`;

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

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: [
                { googleSearch: {} }
            ],
            systemInstruction: `Eres un curador de noticias que DEBE buscar en Google las noticias de HOY y extraer URLs específicas.

FECHA DE HOY: ${fechaHoy}

PROCESO OBLIGATORIO:
1. Busca en Google noticias de las últimas 24 horas
2. Google te dará URLs específicas de cada artículo - ÚSALAS EXACTAMENTE
3. Para cada categoría, encuentra una noticia actual con su URL real
4. Las URLs deben ser de artículos específicos, no de portadas

CATEGORÍAS (genera EXACTAMENTE 5 tarjetas):
- 🌍 Internacional (conflictos, política global, economía mundial)
- 🇲🇽 Nacional México (política, seguridad, economía local)
- 🎭 Espectáculos (celebridades, cine, música VERIFICADO)
- 🎨 Cultura (arte, literatura, tendencias culturales)
- 🔬 Ciencia (descubrimientos, tecnología, salud)

FORMATO HTML EXACTO:
<div class="news-card categoria-lowercase">
  <img src="https://via.placeholder.com/400x200/667eea/ffffff?text=Nombre+del+Medio" alt="Imagen de noticia" class="news-image">
  <div class="news-content">
    <span class="tag categoria-lowercase">CATEGORÍA</span>
    <h3 class="news-title">Título impactante de máximo 70 caracteres</h3>
    <p class="news-summary">Resumen conciso en 2 líneas que explique la noticia claramente.</p>
    <a href="URL_COMPLETA_DEL_ARTICULO_ESPECIFICO" target="_blank" rel="noopener" class="source-btn">Ver noticia 🔗</a>
  </div>
</div>

CLASES CSS: "internacional", "nacional", "espectaculos", "cultura", "ciencia"

REGLAS CRÍTICAS:
1. URLs deben ser COMPLETAS y ESPECÍFICAS del artículo (ej: https://elpais.com/internacional/2026-01-13/titulo-noticia.html)
2. NO uses URLs genéricas como https://elpais.com
3. NO inventes URLs - si no tienes la URL real, busca otra noticia
4. Usa placeholder de imágenes con el nombre del medio
5. Solo noticias de las últimas 24-48 horas
6. Devuelve SOLO el HTML, sin explicaciones ni markdown`
        });

        const prompt = `Busca en Google y genera 5 tarjetas HTML de noticias actuales.

CRÍTICO: Las URLs deben ser de artículos ESPECÍFICOS que Google te proporcione, no de portadas.

Fecha: ${fechaHoy}

Busca en medios reconocidos: El País, BBC, Reforma, CNN, El Universal, Milenio, Forbes, etc.`;

        const result = await model.generateContent(prompt);
        const respuestaTexto = result.response.text();
        
        let htmlLimpio = respuestaTexto
            .replace(/```html/gi, '')
            .replace(/```/g, '')
            .trim();

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

app.post('/clear-cache', (req, res) => {
    cache.clear();
    requestCounts.clear();
    res.json({ message: 'Caché limpiado exitosamente' });
});

app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

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

module.exports = app;