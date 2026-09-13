// Mientras la pantalla está apagada o la app en segundo plano, el navegador
// suele congelar la pestaña: los eventos que "pasaron" ahí (como un error de
// red del audio) no se disparan al toque, sino recién cuando la pantalla
// vuelve a encenderse — momento en el que document.hidden YA es false. Por
// eso no alcanza con chequear document.hidden en el momento del error; hay
// que recordar que "recién volvimos" y, durante una ventana corta después de
// eso, seguir ignorando esos errores fantasma (el archivo en general está
// bien cacheado, como se confirma recargando la página).
window.__mediaErrorIgnoreUntil = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        window.__mediaErrorIgnoreUntil = Infinity; // mientras esté oculta, ignorar todo
    } else {
        window.__mediaErrorIgnoreUntil = Date.now() + 6000; // 6s de gracia al volver
    }
}, { capture: true });

// ===== BLOQUEO DE ORIENTACIÓN (PANTALLA SIEMPRE VERTICAL) =====
// Reemplaza al viejo truco de "contra-rotar" con CSS (que se veía roto en
// algunos celulares) por la Screen Orientation API del navegador: le pedimos
// directamente que bloquee la pantalla en vertical. Sólo funciona en algunos
// contextos (típicamente Android, y a veces sólo si la app está instalada
// como PWA / en pantalla completa) — en los navegadores donde no está
// soportada (ej. Safari/iOS) el pedido simplemente falla en silencio y el
// teléfono rota como siempre, sin romper nada.
function bloquearOrientacionVertical() {
    if (!screen.orientation || !screen.orientation.lock) return;
    screen.orientation.lock('portrait').catch(() => { /* no soportado acá, ignorar */ });
}
bloquearOrientacionVertical();
document.addEventListener('DOMContentLoaded', bloquearOrientacionVertical);
window.addEventListener('load', bloquearOrientacionVertical);
// El lock puede requerir un gesto del usuario o perderse al volver de
// segundo plano/fullscreen — se reintenta en esos momentos.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) bloquearOrientacionVertical();
});
document.addEventListener('click', bloquearOrientacionVertical, { once: true });
document.addEventListener('fullscreenchange', bloquearOrientacionVertical);

// ===== PWA SERVICE WORKER =====
// Registra el SW y, una vez activo, dispara el cacheo de videos/canciones para
// uso offline. Esto va DESPUÉS del install (no adentro), así una descarga larga
// que se corta no tumba el registro entero — y la próxima vez que se abra la
// página, retoma solo lo que falta (ver sw.js: cacheMissingUrls).
if ('serviceWorker' in navigator) {

    // ===== DIAGNÓSTICO EN PANTALLA (sin necesitar consola remota) =====
    // Muestra en el banner cualquier error real de carga de video/audio,
    // con la URL exacta que falló y el motivo — así vemos qué pasa sin
    // depender de conectar el teléfono a una compu.
    window.reportMediaError = function (kind, url, mediaError) {
        // Ignora los errores "fantasma" de pantalla apagada / recién resumido
        // (ver comentario arriba de __mediaErrorIgnoreUntil). Si el problema
        // es real, va a volver a fallar una vez pasada la ventana de gracia.
        if (document.hidden || Date.now() < window.__mediaErrorIgnoreUntil) return;

        const banner = document.getElementById('offline-cache-banner');
        const textEl = document.getElementById('offline-cache-text');
        const barEl = document.getElementById('offline-cache-bar');
        if (!banner || !textEl) return;
        const codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
        const codeName = mediaError ? (codes[mediaError.code] || mediaError.code) : '?';
        banner.style.display = 'block';
        if (barEl) barEl.style.width = '0%';
        const errText = `Error (${kind}) [${codeName}]: ${url}`;
        textEl.dataset.lastError = errText;
        textEl.textContent = errText + ' — pidiendo detalle al SW...';
        console.error(`Error de ${kind}`, codeName, url, mediaError);

        // Pedile al SW que diga EXACTAMENTE qué tiene guardado para esta URL
        // puntual (status, content-type, tamaño declarado vs tamaño real del
        // blob) — así vemos el dato concreto en vez de seguir adivinando.
        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'INSPECT_URL', url });
        } else {
            textEl.textContent = errText + ' (sin SW controller para inspeccionar)';
        }
    };

    // Arma las URLs de TODOS los videos/canciones exactamente como las arma
    // el reproductor (misma función safeUrl/encodeURI), para que lo que se
    // cachea en el fondo haga match sí o sí con lo que se pide al reproducir.
    // Antes el SW armaba estas URLs por su cuenta (sin encodeURI) y terminaban
    // sin coincidir con las que realmente pide el navegador — por eso lo
    // descargado en el fondo no servía offline, pero visitar a mano sí.
    function getAllMediaUrlsForCache() {
        const videoUrls = new Set();
        for (const combo of combosData) {
            for (const dif of Object.values(combo.dificultades || {})) {
                for (const variante of dif) {
                    if (variante.file7t) videoUrls.add(safeUrl(variante.file7t));
                    if (variante.file8t) videoUrls.add(safeUrl(variante.file8t));
                }
            }
        }
        const songUrls = new Set();
        for (const c of canciones) {
            if (c.file) songUrls.add(safeUrl(c.file));
        }
        return { videoUrls: Array.from(videoUrls), songUrls: Array.from(songUrls) };
    }

    // Distingue una descarga PEDIDA A MANO (click en "Descargar" o tocando el
    // banner para reintentar) de una que se retoma sola y en silencio al
    // recargar la página. Solo la primera muestra el banner de progreso y el
    // aviso final de "Listo — X MB guardados"; la segunda no muestra nada
    // salvo que haya un error real.
    let downloadTriggeredManually = false;

    async function startMediaCaching(controller) {
        if (!controller) return;
        // Espera a que el manifest ya esté cargado (combosData poblado) antes
        // de armar la lista — si no, iría vacía.
        if (window.appReadyPromise) {
            try { await window.appReadyPromise; } catch (e) { /* seguimos igual */ }
        }
        const { videoUrls, songUrls } = getAllMediaUrlsForCache();
        controller.postMessage({ type: 'CACHE_MEDIA', videoUrls, songUrls });
    }

    function handleSwMessage(event) {
        const data = event.data || {};
        const banner = document.getElementById('offline-cache-banner');
        const textEl = document.getElementById('offline-cache-text');
        const barEl = document.getElementById('offline-cache-bar');
        if (!banner || !textEl || !barEl) return;

        if (data.type === 'sw-cache-progress' || data.type === 'sw-cache-done') {
            if (!downloadTriggeredManually) return; // corriendo solo en silencio: no mostrar nada
            delete textEl.dataset.lastError;
            const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
            banner.style.display = 'block';
            barEl.style.width = pct + '%';

            // Cada figura tiene 2 archivos (toma de 7 y de 8 tiempos), así que
            // para "Figuras" mostramos el conteo dividido por 2, no el de archivos.
            const isVideos = data.label === 'videos';
            const shownDone = isVideos ? Math.floor(data.done / 2) : data.done;
            const shownTotal = isVideos ? Math.floor(data.total / 2) : data.total;
            const labelNice = isVideos ? 'Figuras' : 'Canciones';

            let msg = `${labelNice}: ${shownDone}/${shownTotal}`;
            if (data.failed) msg += ` (${data.failed} con error, tocá para reintentar)`;
            textEl.textContent = msg;
        } else if (data.type === 'sw-cache-error') {
            banner.style.display = 'block';
            textEl.textContent = `Error cacheando ${data.label} — tocá para reintentar`;
        } else if (data.type === 'sw-cache-summary') {
            // Llega al final de todo el proceso (videos + canciones). Mostramos
            // cuánto quedó realmente guardado en el dispositivo — pero SOLO si
            // esta corrida fue pedida a mano; si fue un retomado silencioso al
            // recargar la página, no mostramos el aviso de "Listo".
            if (downloadTriggeredManually) {
                banner.style.display = 'block';
                barEl.style.width = '100%';
                if (data.usageMB != null) {
                    textEl.textContent = `Listo — ${data.usageMB} MB guardados para uso offline`;
                } else {
                    textEl.textContent = 'Descarga offline completa';
                }
                // Al terminar la descarga manual (pedida por el usuario tocando
                // "Descargar" en el menú), esperamos a que se vea el cartel de
                // "Listo" y recargamos la página — así queda todo recién
                // servido desde el cache que se acaba de completar.
                setTimeout(() => { location.reload(); }, 7000);
            } else {
                banner.style.display = 'none';
            }
            downloadTriggeredManually = false;
        } else if (data.type === 'sw-cache-status') {
            // Respuesta a "mantener presionado el banner" — cuánto hay
            // REALMENTE en el cache ahora mismo, sin descargar nada nuevo.
            banner.style.display = 'block';
            const v = data.videos || { done: 0, total: 0 };
            const c = data.canciones || { done: 0, total: 0 };
            textEl.textContent = `En cache ahora: Figuras ${Math.floor(v.done / 2)}/${Math.floor(v.total / 2)} · Canciones ${c.done}/${c.total}`;
        } else if (data.type === 'sw-inspect-result') {
            // Respuesta puntual a INSPECT_URL, disparada automáticamente
            // cuando un video/audio falla — muestra qué hay REALMENTE
            // guardado para esa URL exacta (o si ni siquiera está cacheada).
            banner.style.display = 'block';
            let detail;
            if (!data.cached) {
                detail = `NO está en cache${data.error ? ' (' + data.error + ')' : ''}`;
            } else {
                detail = `cache: status=${data.status} ct=${data.contentType || '?'} `
                    + `content-length=${data.contentLength || '?'} content-range=${data.contentRange || '-'} `
                    + `bytes reales=${data.actualBlobSize != null ? data.actualBlobSize : (data.blobReadError || '?')}`;
            }
            const prefix = textEl.dataset.lastError ? textEl.dataset.lastError + ' | ' : '';
            textEl.textContent = prefix + detail;
            console.error('[SW inspect]', data);
        } else if (data.type === 'sw-fetch-error') {
            // El SW tiró una excepción real al intentar servir este pedido
            // (ej: serveRange falló) — esto antes se tragaba en silencio.
            banner.style.display = 'block';
            const prefix = textEl.dataset.lastError ? textEl.dataset.lastError + ' | ' : '';
            textEl.textContent = `${prefix}SW error (${data.stage}): ${data.message} — range=${data.range || '-'} — ${data.url}`;
            console.error('[SW fetch error]', data);
        }
    }

    // Tocar el banner reintenta lo que haya fallado o quedado pendiente —
    // esto también es una acción explícita del usuario, así que muestra el
    // banner normalmente (incluido el aviso final de "Listo").
    document.addEventListener('DOMContentLoaded', () => {
        const banner = document.getElementById('offline-cache-banner');
        if (banner) {
            banner.addEventListener('click', () => {
                downloadTriggeredManually = true;
                startMediaCaching(navigator.serviceWorker.controller);
            });
        }
    });

    navigator.serviceWorker.addEventListener('message', handleSwMessage);

    // La descarga para modo avión YA NO arranca sola al cargar la página —
    // solo se dispara cuando el usuario toca "Descargar" en el menú (☰).
    // Guardamos esa decisión en localStorage para que, si la descarga quedó
    // a mitad de camino (se cerró la app, se cortó la conexión, etc.), la
    // próxima vez que se abra la página se retome sola donde quedó — sin
    // que el usuario tenga que volver a pedirla cada vez (pero en silencio,
    // sin mostrar el banner ni el aviso de "Listo" otra vez).
    const OFFLINE_DOWNLOAD_KEY = 'offlineDownloadRequested';

    window.requestOfflineDownload = function () {
        downloadTriggeredManually = true;
        localStorage.setItem(OFFLINE_DOWNLOAD_KEY, '1');
        if (navigator.serviceWorker.controller) {
            startMediaCaching(navigator.serviceWorker.controller);
        } else {
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                startMediaCaching(navigator.serviceWorker.controller);
            }, { once: true });
        }
    };

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(() => navigator.serviceWorker.ready)
            .then(async () => {
                // Pedile al navegador que NO borre el cache bajo presión de espacio
                // (si no, Android puede vaciar los videos/canciones ya descargados).
                if (navigator.storage && navigator.storage.persist) {
                    try { await navigator.storage.persist(); } catch (e) { /* no crítico */ }
                }
                // Solo retomamos la descarga automáticamente si el usuario ya la
                // había pedido antes alguna vez. Si nunca la pidió, no se toca
                // la red hasta que la pida desde el menú.
                if (localStorage.getItem(OFFLINE_DOWNLOAD_KEY) === '1') {
                    if (navigator.serviceWorker.controller) {
                        startMediaCaching(navigator.serviceWorker.controller);
                    } else {
                        navigator.serviceWorker.addEventListener('controllerchange', () => {
                            startMediaCaching(navigator.serviceWorker.controller);
                        }, { once: true });
                    }
                }
            })
            .catch(err => console.error('Error al registrar SW', err));
    });
}

// ===== CONFIGURACION DE GRILLAS POR CANTIDAD DE TOMAS =====
// Cada nivel de Dificultad (D1..D4) tiene su propio set real de tomas (ya no es
// un "techo" que reutiliza la misma lista como antes con MaxH). La grilla a
// mostrar se elige automáticamente según cuántas tomas tenga esa dificultad.
const GRID_TIERS = [
    { cols: 1, rows: 1, perPage: 1 },
    { cols: 2, rows: 2, perPage: 4 },
    { cols: 3, rows: 3, perPage: 9 },
    { cols: 4, rows: 4, perPage: 16 }
];

// Devuelve la grilla más chica que entra TODAS las tomas (hasta 4x4=16; si hay
// más, las sobrantes no se muestran).
function getGridTierParaCount(count) {
    for (const tier of GRID_TIERS) {
        if (count <= tier.perPage) return tier;
    }
    return GRID_TIERS[GRID_TIERS.length - 1];
}

// Mute inmediato mientras carga, desmute al terminar
let _mutedForLoad = false;
function mutearParaCarga() {
    if (!audioPlayer.muted) {
        audioPlayer.muted = true;
        _mutedForLoad = true;
    }
}
function desmutearTrasCarga() {
    if (_mutedForLoad) {
        audioPlayer.muted = false;
        _mutedForLoad = false;
        // Sincronizar ícono del botón mute
        document.getElementById('mute-btn').innerText = '🔊';
    }
}

// ===== BASE DE DATOS DE FIGURAS (AUTOMÁTICA, DESDE figuras-manifest.json) =====
// Ya no hay figuras hardcodeadas acá. El archivo figuras-manifest.json se genera
// con generar-manifest.html (abrila en el navegador, elegís la carpeta de videos
// y descargás el JSON) y se coloca junto a index.html.
//
// Cada "combo" es una combinación real (Posición Inicial, Figura, Posición Final)
// encontrada en los nombres de archivo. Sus tomas están agrupadas por Dificultad
// (D1..D4), y dentro de cada dificultad puede haber varias variantes (tomas -v2, -v3, etc.)
// agrupadas automáticamente.
let combosData = [];       // [{id, posIni, figura, posFin, dificultades:{D1:[{file7t,file8t},...], D2:[...]}}]
let comboByKey = {};       // id -> combo
let figurasData = {};      // id -> {D1:[...], D2:[...], ...}
let figurasUnicas = [];    // lista de valores de "figura" distintos, ordenada
let posicionesUnicas = []; // lista de valores de posición (inicial o final) distintos

// ===== CÓDIGOS CORTOS DE POSICIÓN (botones de encadenar, ver más abajo) =====
// Para cada Posición se arma un código corto (ej. "Posición Abierta Relajada
// Paralelas al Aire 2" -> "PARPaA2"): primera letra de cada palabra
// significativa (se saltean conectores como "al"/"en"), números tal cual.
// El mapa palabra->código se arma UNA sola vez con TODAS las Posiciones
// existentes (construirMapaCodigosPosicion), en el orden en que aparecen: si
// dos palabras distintas empezarían con la misma letra, la que aparece
// después se alarga a 2 (o más) letras para no repetirla.
const POSICION_CODE_STOPWORDS = new Set(['al', 'en', 'de', 'del', 'la', 'el', 'los', 'las', 'sin', 'con', 'y', 'a']);
let posicionCodeMap = {};
let posicionCodeCache = {};

function construirMapaCodigosPosicion(posiciones) {
    posicionCodeMap = {};
    posicionCodeCache = {};
    const codigosUsados = new Set();
    posiciones.forEach(nombre => {
        if (!nombre) return;
        nombre.split(/\s+/).forEach(palabra => {
            const clave = palabra.toLowerCase();
            if (posicionCodeMap[clave] !== undefined) return; // palabra ya vista
            if (/^\d+$/.test(palabra)) return; // los números no llevan código propio
            if (POSICION_CODE_STOPWORDS.has(clave)) return; // conector, se saltea
            let longitud = 1;
            let candidato = palabra.slice(0, longitud).toLowerCase();
            while (codigosUsados.has(candidato) && longitud < palabra.length) {
                longitud++;
                candidato = palabra.slice(0, longitud).toLowerCase();
            }
            codigosUsados.add(candidato);
            posicionCodeMap[clave] = candidato.charAt(0).toUpperCase() + candidato.slice(1);
        });
    });
}

function codigoDePosicion(nombre) {
    if (typeof nombre !== 'string' || nombre === '') return '---';
    if (posicionCodeCache[nombre] !== undefined) return posicionCodeCache[nombre];
    const codigo = nombre.split(/\s+/).map(palabra => {
        if (/^\d+$/.test(palabra)) return palabra;
        const clave = palabra.toLowerCase();
        if (POSICION_CODE_STOPWORDS.has(clave)) return '';
        return posicionCodeMap[clave] || palabra.charAt(0).toUpperCase();
    }).join('');
    posicionCodeCache[nombre] = codigo;
    return codigo;
}
let dificultadesUnicas = []; // lista de niveles de dificultad distintos (D1, D2, ...), ordenada

// Filtros activos de los 4 desplegables. null = "cualquiera" (sin filtrar esa dimensión).
let filterFigura = null;

// Filtro de "texto libre" PROPIO de la Lupa (buscador de Movimiento, 🔍/L),
// separado de filterFigura a propósito: antes, tipear en la Lupa y
// confirmar (Enter, o el ítem "🔎 Todas las que contengan...") terminaba
// pisando el filtro de Figura (y mostrando ese texto en el desplegable de
// Figura), lo cual era confuso porque el usuario lo había escrito en la
// Lupa, no ahí. Ahora ese texto se guarda acá, combina Dificultad +
// Posición Inicial + Figura + Posición Final (ver textoCombinadoDeCombo /
// comboCoincideTextoLibreMovSearch), y la única señal visual de que está
// activo es el ícono de la Lupa resaltado (ver actualizarEstadoBotonMovSearch).
let filterMovSearchTexto = null;
let filterPosIni = null;
let filterPosFin = null;
let filterDificultad = null;

// Toggles "I" (Individuales) y "C" (Combos) del desplegable de Figura:
// controlan qué categoría de tomas existe en TODA la app (no solo en el
// desplegable), igual que cualquier otro filtro.
// - mostrarCombos ("C"): si está activo se muestran las tomas cuya Figura
//   combina varios movimientos ("A + B"); si se desactiva, esas tomas se
//   ocultan del todo.
// - mostrarFigurasIndividuales ("I"): si está activo se muestran las tomas
//   cuya Figura es un solo movimiento (sin "+"); si se desactiva, esas
//   tomas se ocultan del todo.
// Ambos activados por defecto al cargar la página (si algún día se
// desactivaran los dos a la vez, no quedaría ninguna toma para mostrar).
// Persistidos igual que el resto de preferencias de la app.
let mostrarCombos = (localStorage.getItem('mostrarCombos') !== '0');
let mostrarFigurasIndividuales = (localStorage.getItem('mostrarFigurasIndividuales') !== '0');

// Toggle "=" entre Posición Inicial y Posición Final: igual concepto que los
// toggles "I"/"C" de arriba (interruptor de visibilidad de toda la app, no
// una dimensión de filtro más). Si está activo, sólo existen en toda la app
// las tomas cuya Posición Inicial y Posición Final sean exactamente la
// misma. Desactivado por defecto (a diferencia de "I"/"C").
let filtroPosIgual = (localStorage.getItem('filtroPosIgual') === '1');

// Toggle "Mostrar figuras ocultas" (menú ☰): igual concepto que los toggles
// de arriba (interruptor de visibilidad de toda la app), pero para las
// tomas puntuales que el usuario ocultó a mano con el botón 🙈. Desactivado
// por defecto (las ocultas NO se ven). Guardado en cookie, igual que las
// listas de Favoritos (getCookie/setCookie están más abajo en el archivo,
// pero al ser "function" quedan disponibles ("hoisted") desde acá).
let mostrarFigurasOcultas = (getCookie('mostrarFigurasOcultas') === '1');

// Muchas figuras son "compuestas" (ej. "Gancho + Traslado": son dos
// movimientos hechos seguidos). Para que el filtro de Figura las encuentre
// también al buscar por cada movimiento individual, y para poder elegir
// "Gancho" aunque no exista ninguna toma que sea SÓLO "Gancho", se
// descompone cada figura en las partes separadas por "+".
function componentesDeFigura(figuraStr) {
    if (!figuraStr) return [figuraStr]; // "" (sin nombre propio) es un valor válido en sí mismo
    return figuraStr.split('+').map(s => s.trim()).filter(Boolean);
}

// ===== FILTROS DE "TEXTO LIBRE" (estilo __Reordenador.py) =====
// Además de elegir un valor exacto y preconfigurado en los desplegables de
// Figura / Posición Inicial / Posición Final, se puede escribir cualquier
// texto y confirmarlo (Enter, o clickeando el ítem "🔎 Todas las que
// contengan...") para que el filtro pase a ser "contiene este texto" en vez
// de "es exactamente este valor". Así, escribir "Doble Péndulo" agrupa de
// una sola vez a "Doble Péndulo Cruzado", "Doble Péndulo Paralelo", etc.
// Estos filtros se representan con un objeto {__texto:true, texto, original}
// en vez de un string simple, para poder distinguirlos de una selección
// exacta en cualquier punto del código que compare el valor del filtro.
function esFiltroTexto(valor) {
    return valor !== null && typeof valor === 'object' && valor.__texto === true;
}

function crearFiltroTexto(textoOriginal) {
    const original = (textoOriginal || '').trim();
    if (original === '') return null;
    return { __texto: true, texto: normalizarTexto(original), original };
}

// Aplica el texto tipeado en el buscador de Figura / Posición Inicial /
// Posición Final como filtro de "texto libre" (ver esFiltroTexto), en vez
// de tener que elegir un valor exacto de la lista. Se dispara al clickear
// el ítem "🔎 Todas las que contengan..." o al apretar Enter con el
// desplegable abierto y nada resaltado por teclado. Devuelve false (sin
// tocar nada) si el texto está vacío, para que quien la llama pueda hacer
// un fallback razonable (por ejemplo, confirmar el ítem resaltado si lo hay).
function aplicarFiltroTextoLibre(dimension, textoOriginal) {
    // El buscador de Movimiento (🔍, L) tiene su propio filtro de texto
    // libre, separado de Figura (ver filterMovSearchTexto) — se resuelve
    // aparte para no tocar ninguno de los otros 3 (Figura/Posición Inicial/
    // Posición Final).
    if (dimension === 'movsearch') return aplicarFiltroTextoLibreMovSearch(textoOriginal);
    const filtro = crearFiltroTexto(textoOriginal);
    if (!filtro) return false;
    if (dimension === 'figura') {
        filterFigura = filtro;
        ultimaDimensionSeleccionada = 'figura';
    } else if (dimension === 'posIni') {
        filterPosIni = filtro;
        // Con "=" activado, Posición Inicial y Final van siempre atadas.
        if (filtroPosIgual) filterPosFin = filtro;
        ultimaDimensionSeleccionada = 'posIni';
    } else if (dimension === 'posFin') {
        filterPosFin = filtro;
        if (filtroPosIgual) filterPosIni = filtro;
        ultimaDimensionSeleccionada = 'posFin';
    } else {
        return false;
    }
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
    return true;
}

// Aplica (o limpia, si el texto queda vacío) el filtro de texto libre PROPIO
// de la Lupa (🔍, L) — ver filterMovSearchTexto. A diferencia de
// aplicarFiltroTextoLibre, NO toca filterFigura ni ningún otro de los 3
// filtros con desplegable propio: sólo actualiza filterMovSearchTexto y
// resalta el ícono de la Lupa (ver actualizarEstadoBotonMovSearch), para que
// quede claro que la búsqueda quedó guardada AHÍ y no en el menú de Figuras.
function aplicarFiltroTextoLibreMovSearch(textoOriginal) {
    const filtro = crearFiltroTexto(textoOriginal);
    if (!filtro && filterMovSearchTexto === null) return false;
    filterMovSearchTexto = filtro;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
    actualizarEstadoBotonMovSearch();
    return true;
}

// Resalta (clase .active) el ícono de la Lupa cuando filterMovSearchTexto
// está activo, para que se note de un vistazo que hay una búsqueda cargada
// ahí, sin tener que abrir el panel.
function actualizarEstadoBotonMovSearch() {
    const btn = document.getElementById('movsearch-btn');
    if (!btn) return;
    const activa = filterMovSearchTexto !== null;
    btn.classList.toggle('active', activa);
    btn.title = activa
        ? `Buscar Movimiento por código o texto libre en Dificultad/Posición/Figura (L) — búsqueda activa: "${filterMovSearchTexto.original}"`
        : 'Buscar Movimiento por código o texto libre en Dificultad/Posición/Figura (L)';
}

// Un combo "coincide" con un valor de filtro de Figura si:
// - el filtro es de texto libre: alcanza con que el texto aparezca en
//   cualquier parte de la Figura completa (sin importar tildes/mayúsculas);
// - si no, el valor es exactamente su figura completa (compuesta o no,
//   permite elegir "Gancho + Traslado" a propósito) O es uno de los
//   movimientos individuales que la componen (permite que "Gancho" o
//   "Traslado" por separado también encuentren esta toma compuesta).
function comboCoincideFigura(combo, valor) {
    if (esFiltroTexto(valor)) {
        return contieneTodasLasPalabras(combo.figura, valor.original);
    }
    if (combo.figura === valor) return true;
    return componentesDeFigura(combo.figura).includes(valor);
}

// Mismo criterio que comboCoincideFigura, pero para un campo de valor único
// (Posición Inicial / Posición Final: no tienen componentes "+").
function coincideValorPos(valorCombo, filtro) {
    if (esFiltroTexto(filtro)) {
        return contieneTodasLasPalabras(valorCombo, filtro.original);
    }
    return valorCombo === filtro;
}

// Texto combinado de un combo (Dificultad(es) que le quedan + Posición
// Inicial + Figura + Posición Final), usado por el filtro de "texto libre"
// PROPIO de la Lupa (ver filterMovSearchTexto): el mismo criterio combinado
// que ya usa renderMovSearchList al tipear en el buscador de Movimiento.
function textoCombinadoDeCombo(combo) {
    const dificultadesTexto = combo.dificultades
        ? Object.keys(combo.dificultades).filter(d => combo.dificultades[d] && combo.dificultades[d].length).join(' ')
        : '';
    return `${dificultadesTexto} ${combo.posIni} ${combo.figura} ${combo.posFin}`;
}

function comboCoincideTextoLibreMovSearch(combo, filtro) {
    return contieneTodasLasPalabras(textoCombinadoDeCombo(combo), filtro.original);
}

// Texto a mostrar en el "-selected" de un desplegable para el valor de un
// filtro (exacto o de texto libre).
function etiquetaValorFiltro(valor) {
    if (esFiltroTexto(valor)) return `🔎 "${valor.original}"`;
    return valor === '' ? '---' : valor;
}

// Cuenta cuántas tomas de una Dificultad puntual de un combo quedan
// "visibles" (no ocultas). Con hiddenSteps vacío (nada oculto, o "Mostrar
// figuras ocultas" activo) es simplemente la cantidad total de tomas.
function tomasVisiblesDeCombo(combo, dificultad, hiddenSteps) {
    const tomas = (combo.dificultades && combo.dificultades[dificultad]) || [];
    if (!hiddenSteps.length) return tomas.length;
    let count = 0;
    tomas.forEach((toma, variantIndex) => {
        if (!pasoEstaOculto(hiddenSteps, combo.id, dificultad, variantIndex, toma)) count++;
    });
    return count;
}

// ¿Le queda a este combo alguna toma visible? Si se pasa una dificultadUnica
// puntual (porque hay un filtro de Dificultad activo que no se está
// excluyendo), sólo se mira esa; si no, alcanza con que CUALQUIERA de sus
// dificultades tenga algo visible.
function comboTieneTomaVisible(combo, hiddenSteps, dificultadUnica) {
    if (!hiddenSteps.length) return true; // nada oculto: no hace falta revisar
    const dificultades = dificultadUnica ? [dificultadUnica] : Object.keys(combo.dificultades || {});
    return dificultades.some(d => tomasVisiblesDeCombo(combo, d, hiddenSteps) > 0);
}

// Devuelve los combos que cumplen los filtros activos, opcionalmente ignorando
// una dimensión (para calcular las OPCIONES de esa misma dimensión sin que se
// autofiltre a sí misma).
function combosFiltrados(excluirDimension) {
    // Con "=" activado, Posición Inicial y Posición Final quedan atadas como
    // si fueran una sola dimensión: al calcular las opciones disponibles
    // para CUALQUIERA de las dos, hay que ignorar el filtro de las DOS (no
    // sólo el de la que se está calculando) — si no, la otra ya fijada al
    // mismo valor sólo dejaría ver esa misma igualdad y "Cualquiera".
    const excluirPosIni = excluirDimension === 'posIni' || (filtroPosIgual && excluirDimension === 'posFin');
    const excluirPosFin = excluirDimension === 'posFin' || (filtroPosIgual && excluirDimension === 'posIni');
    // Las Figuras ocultas (🙈) no deberían inflar los desplegables de
    // Figura/Dificultad/Posición con opciones que ya no llevan a ningún
    // Movimiento real — salvo que "Mostrar figuras ocultas" esté activo,
    // en cuyo caso se ignoran (mismo criterio que construirPasosFiltrados).
    const hiddenSteps = mostrarFigurasOcultas ? [] : getHiddenSteps();
    // Si el filtro de Dificultad está activo y no es la dimensión que se
    // está excluyendo, sólo esa Dificultad puntual cuenta para decidir si
    // al combo le queda algo visible (si no, otra Dificultad oculta del
    // mismo combo lo haría pasar igual, aunque la elegida esté vacía).
    const dificultadParaVisibilidad = (excluirDimension !== 'dificultad') ? filterDificultad : null;
    return combosData.filter(c => {
        // Toggles "I"/"C": no respetan 'excluirDimension' (igual que los
        // demás filtros no lo hacen para SU propia dimensión) porque no son
        // una dimensión de filtro más: son un interruptor de visibilidad
        // que aplica siempre, en toda la app.
        if (typeof c.figura === 'string') {
            const esCombo = c.figura.includes('+');
            if (esCombo && !mostrarCombos) return false;
            if (!esCombo && !mostrarFigurasIndividuales) return false;
        }
        // Toggle "=": igual que "I"/"C", aplica siempre en toda la app, sin
        // importar 'excluirDimension' (así los desplegables de Posición
        // Inicial/Final también quedan reducidos a las posiciones que
        // cumplen esta condición).
        if (filtroPosIgual && c.posIni !== c.posFin) return false;
        if (excluirDimension !== 'figura' && filterFigura !== null && !comboCoincideFigura(c, filterFigura)) return false;
        // Filtro de texto libre PROPIO de la Lupa (independiente de Figura):
        // se aplica siempre (no tiene desplegable propio del que excluirse),
        // salvo cuando se están recalculando candidatos PARA la Lupa misma.
        if (excluirDimension !== 'movsearch' && filterMovSearchTexto !== null && !comboCoincideTextoLibreMovSearch(c, filterMovSearchTexto)) return false;
        if (!excluirPosIni && filterPosIni !== null && !coincideValorPos(c.posIni, filterPosIni)) return false;
        if (!excluirPosFin && filterPosFin !== null && !coincideValorPos(c.posFin, filterPosFin)) return false;
        if (excluirDimension !== 'dificultad' && filterDificultad !== null && !(c.dificultades && c.dificultades[filterDificultad] && c.dificultades[filterDificultad].length)) return false;
        if (!comboTieneTomaVisible(c, hiddenSteps, dificultadParaVisibilidad)) return false;
        return true;
    });
}

// figurasData es simplemente un alias del campo "dificultades" de cada combo:
// id -> {D1:[{file7t,file8t},...], D2:[...], ...}. Cada dificultad tiene su
// propio set real de tomas (ya no se reutiliza una misma lista como con MaxH).
function construirFigurasData(combos) {
    const data = {};
    combos.forEach(combo => {
        data[combo.id] = combo.dificultades || {};
    });
    return data;
}

// Lista de niveles de dificultad (D1, D2, ...) presentes entre los combos que
// cumplen los demás filtros activos (para poblar el desplegable de Dificultad).
function nivelesDificultadDisponibles() {
    const candidatos = combosFiltrados('dificultad');
    // Mismo criterio de "figuras ocultas" que combosFiltrados, pero acá hay
    // que aplicarlo por Dificultad puntual: un combo puede tener, por
    // ejemplo, D1 completamente oculta pero D2 visible, y en ese caso D1 no
    // debería ofrecerse como opción aunque el combo sí pase el resto de los
    // filtros (por eso no alcanza con combosFiltrados solo).
    const hiddenSteps = mostrarFigurasOcultas ? [] : getHiddenSteps();
    const set = new Set();
    candidatos.forEach(c => {
        Object.keys(c.dificultades || {}).forEach(d => {
            if (!c.dificultades[d] || !c.dificultades[d].length) return;
            if (hiddenSteps.length && tomasVisiblesDeCombo(c, d, hiddenSteps) === 0) return;
            set.add(d);
        });
    });
    return [...set].sort((a, b) => parseInt(a.replace('D', '')) - parseInt(b.replace('D', '')));
}

// Fija los filtros de Figura/Posición exactamente en los valores de un combo
// puntual (usado por las flechas ↑/↓ y por la selección inicial), dejando el
// estado 100% explícito. El filtro de Dificultad NO se toca acá: se respeta el
// que ya estuviera elegido (o "cualquiera").
function activarComboCompleto(comboId) {
    const combo = comboByKey[comboId];
    if (!combo) return;
    // combo.figura puede ser "" (figuras sin nombre propio, mostradas como
    // "---" (mostrado así en pantalla)): hay que preservar ese "" tal cual, no convertirlo en null como
    // haría "||" (eso las trataba como si no hubiera filtro de Figura).
    filterFigura = (typeof combo.figura === 'string') ? combo.figura : null;
    // Mismo criterio que Figura: si el combo no tiene Posición Inicial/Final
    // propia (""), hay que preservar ese "" tal cual (selección real y
    // explícita de "---"), no convertirlo en null con "||".
    filterPosIni = (typeof combo.posIni === 'string') ? combo.posIni : null;
    filterPosFin = (typeof combo.posFin === 'string') ? combo.posFin : null;
    currentFigureValue = comboId;
    actualizarEtiquetasFiltros();
    cargarDificultad();
}

// Recalcula cuál es el combo "actual" según los filtros activos (puede haber más
// de una combinación posible si el usuario todavía no terminó de filtrar; en ese
// caso se muestra la primera en orden alfabético hasta que se termine de acotar).
function recalcularComboActual() {
    let candidatos = combosFiltrados(null);
    if (candidatos.length === 0) {
        // Seguridad: no debería pasar si las listas se generan bien filtradas.
        filterFigura = null;
        filterPosIni = null;
        filterPosFin = null;
        filterDificultad = null;
        // Misma lógica de seguridad para el filtro propio de la Lupa: si
        // combinado con los otros 4 no deja NINGÚN candidato, se limpia
        // también acá (si no, la app podría quedar trabada en "no hay nada
        // para mostrar" incluso después de resetear los otros 4).
        filterMovSearchTexto = null;
        // OJO: acá antes se usaba combosData.slice() a secas, ignorando los
        // toggles "I"/"C". Si el usuario los desactivó a los dos a la vez
        // (no queda ninguna toma: ni Combos ni Figuras individuales), no
        // hay que volver a mostrar TODO como si nada: se respeta esa
        // elección y directamente no hay nada para mostrar.
        candidatos = combosFiltrados(null);
        if (candidatos.length === 0) {
            actualizarEtiquetasFiltros(candidatos);
            actualizarPaginacion();
            return;
        }
    }
    candidatos = candidatos.slice().sort(compararCombos);
    actualizarEtiquetasFiltros(candidatos);

    // Siempre arrancamos desde la PRIMERA toma del conjunto filtrado (para
    // que el contador de arriba empiece en 1/X), en vez de dejar que la
    // preferencia de Dificultad guardada nos deje en cualquier otra página.
    const pasos = construirPasosFiltrados();
    if (pasos.length > 0) {
        currentFigureValue = pasos[0].comboId;
        currentDificultadValue = pasos[0].dificultad;
        currentVariantIndex = pasos[0].variantIndex;
        actualizarEtiquetaDificultad();
        actualizarPaginacion();
    } else {
        currentFigureValue = candidatos[0].id;
        cargarDificultad();
    }
}

// El orden por defecto (sin filtros) sigue el mismo criterio que el nombre
// de archivo: "PosIniciarial_Figura_PosFinal_Dificultad_Xt.mp4". Por eso acá
// se ordena primero por Posición Inicial, después Figura, después Posición
// Final: así el orden de "Movimiento 1, 2, 3..." al cargar la página (o al
// navegar sin filtros) coincide con el orden alfabético de los archivos.
function compararCombos(a, b) {
    const ordenA = (a.orden ?? null);
    const ordenB = (b.orden ?? null);
    if (ordenA !== null && ordenB !== null && ordenA !== ordenB) return ordenA - ordenB;
    if (ordenA !== null && ordenB === null) return -1;
    if (ordenA === null && ordenB !== null) return 1;
    return (a.posIni || '').localeCompare(b.posIni || '')
        || (a.figura || '').localeCompare(b.figura || '')
        || (a.posFin || '').localeCompare(b.posFin || '');
}

// Pone el contenido de un "-selected" (fig/ver/posini/posfin/song) SIEMPRE
// envuelto en un span propio (.dropdown-label-text). Así el texto se recorta
// con "..." dentro de ese span (que tiene su propio min-width:0) en vez de
// empujar o tapar la flechita del desplegable (background-image del padre),
// que queda siempre limpia sin importar cuán largo sea el texto.
function setDropdownSelectedHTML(elId, innerHtml) {
    document.getElementById(elId).innerHTML = `<span class="dropdown-label-text">${innerHtml}</span>`;
}

// Actualiza el texto de los 3 desplegables. Si una dimensión no tiene filtro propio
// pero todos los combos candidatos comparten el mismo valor, se muestra igual
// (autocompletado visual); si no, se muestra el placeholder de "sin elegir".
function actualizarEtiquetasFiltros(candidatos) {
    if (!candidatos) candidatos = combosFiltrados(null);
    const valorUnico = (campo) => {
        const set = new Set(candidatos.map(c => c[campo]).filter(Boolean));
        return set.size === 1 ? [...set][0] : null;
    };

    // El label de Figura sólo muestra un nombre si el usuario lo eligió
    // explícitamente (filterFigura !== null). Antes se "autocompletaba" con
    // valorUnico('figura') cuando, al filtrar por Posición Inicial/Final,
    // sólo quedaba una figura posible: eso hacía que "Cualquier Figura"
    // desapareciera solo. Ahora se mantiene en "Cualquier Figura" hasta que
    // el usuario la elija a propósito. filterFigura === "" es una selección
    // real y explícita (las figuras "sin nombre"), se muestra como "---".
    if (filterFigura === null) {
        setDropdownSelectedHTML('fig-selected', `💃 Cualquier Figura [🌈]`);
    } else {
        setDropdownSelectedHTML('fig-selected', `💃 ${etiquetaValorFiltro(filterFigura)}`);
    }

    setDropdownSelectedHTML('posini-selected', (filterPosIni === null)
        ? `<span class="pos-dot pos-dot-ini"></span>Cualquier Posición Inicial [🌈]`
        : `<span class="pos-dot pos-dot-ini"></span>${etiquetaValorFiltro(filterPosIni)}`);

    setDropdownSelectedHTML('posfin-selected', (filterPosFin === null)
        ? `<span class="pos-dot pos-dot-fin"></span>Cualquier Posición Final [🌈]`
        : `<span class="pos-dot pos-dot-fin"></span>${etiquetaValorFiltro(filterPosFin)}`);

    actualizarEstadoBotonMovSearch();
}

// Carga figuras-manifest.json (generado con generar-manifest.html) y arranca la app.
async function iniciarApp() {
    try {
        const resp = await fetch('figuras-manifest.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const manifest = await resp.json();
        combosData = (manifest.combos || []).slice().sort(compararCombos);
        comboByKey = {};
        combosData.forEach(c => { comboByKey[c.id] = c; });
        figurasData = construirFigurasData(combosData);
        figurasUnicas = [...new Set(combosData.flatMap(c => [c.figura, ...componentesDeFigura(c.figura)]))]
            .sort((a, b) => (a === '' ? '---' : a).localeCompare(b === '' ? '---' : b));
        posicionesUnicas = [...new Set(combosData.flatMap(c => [c.posIni, c.posFin]).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
        construirMapaCodigosPosicion(posicionesUnicas);
        dificultadesUnicas = [...new Set(combosData.flatMap(c => Object.keys(c.dificultades || {})))]
            .sort((a, b) => parseInt(a.replace('D', '')) - parseInt(b.replace('D', '')));
    } catch (err) {
        console.error('No se pudo cargar figuras-manifest.json', err);
        const loadingText = document.querySelector('#loading-indicator .loading-text');
        if (loadingText) loadingText.innerText = 'Error: falta figuras-manifest.json junto a index.html';
        return;
    }

    if (combosData.length === 0) {
        const loadingText = document.querySelector('#loading-indicator .loading-text');
        if (loadingText) loadingText.innerText = 'figuras-manifest.json está vacío';
        return;
    }

    setupSelects();
    renderGrid();
    prepararFuentes();
    actualizarEstadoBotonFavAdd();
    actualizarEstadoBotonHide();
    actualizarEstadoBotonNota();
    actualizarEstadoBotonFavSaveFiltered();
    actualizarEtiquetaFigurasOcultas();
}

let canciones = [
    { name: "Alucinante (DJ Tony Pecino) - Liley & Nando Boom", bpm: 106, file: "Canciones/Alucinante (DJ Tony Pecino) - Liley & Nando Boom_106bpm_1al8_x12.mp3" },
    { name: "Barcelona - Charles Luis, Dimelo Cupido & DJ Husky", bpm: 130, file: "Canciones/Barcelona - Charles Luis, Dimelo Cupido & DJ Husky_130bpm_1al8_x8.mp3" },
    // { name: "Besos Mojados - Itzza Primera & Mayinbito", bpm: 128, file: "Canciones/Besos Mojados - Itzza Primera & Mayinbito_130bpm.mp3" },
    { name: "Bypass - MR. Don", bpm: 105, file: "Canciones/Bypass - MR. Don_105bpm_1al8_x12.mp3" },
    // { name: "Calumnia - Carlos Rivera & Prince Royce", bpm: 139, file: "Canciones/Calumnia - Carlos Rivera & Prince Royce_139bpm_1al8_x12.mp3" },
    { name: "Cerremos Ese Capítulo - Mayinbito", bpm: 124, file: "Canciones/Cerremos Ese Capítulo - Mayinbito_124bpm.mp3" },
    { name: "Cobardes Al Amar (feat. DJ Clau) [Bachata Version] - Kevin Vásquez", bpm: 119, file: "Canciones/Cobardes Al Amar (feat. DJ Clau) [Bachata Version] - Kevin Vásquez_119bpm.mp3" },
    { name: "Como Yo Te Quiero - KHEA", bpm: 133, file: "Canciones/Como Yo Te Quiero - KHEA_133bpm_1al8_x12.mp3" },
    { name: "Dos De Mi (feat. Mickey Then) - JR.", bpm: 126, file: "Canciones/Dos De Mi (feat. Mickey Then) - JR._126bpm.mp3" },
    // { name: "El Acuerdo - DJ Husky & SHAMA", bpm: 127, file: "Canciones/El Acuerdo - DJ Husky & SHAMA_127bpm.mp3" },
    { name: "Estaré Esperándote - SHAMA", bpm: 125, file: "Canciones/Estaré Esperándote - SHAMA_125bpm_1al8_x15.mp3" },
    { name: "Feeling Something - Pinto Picasso", bpm: 124, file: "Canciones/Feeling Something - Pinto Picasso_124bpm.mp3" },
    { name: "Fronteo - Pinto Picasso & SP Polanco", bpm: 113, file: "Canciones/Fronteo - Pinto Picasso & SP Polanco_113bpm_1al8_x12.mp3" },
    { name: "In The Stars - Dimen5ions & Bachata Influence", bpm: 132, file: "Canciones/In The Stars - Dimen5ions & Bachata Influence_132bpm.mp3" },
    { name: "La Corriente - Prince Royce", bpm: 127, file: "Canciones/La Corriente - Prince Royce_127bpm_1al8_x12.mp3" },
    { name: "Lejanía - Jensen", bpm: 130, file: "Canciones/Lejanía - Jensen_130bpm_1al8_x15.mp3" },
    // { name: "Lo Tenias Callao - Jean & Alex", bpm: 128, file: "Canciones/Lo Tenias Callao - Jean & Alex_128bpm_1al8_x16.mp3" },
    // { name: "Luna De Crucero - SP Polanco & Jean & Alex", bpm: 117, file: "Canciones/Luna De Crucero - SP Polanco & J/ean & Alex_117bpm.mp3" },
    // { name: "Madrugadas - Jensen & Myguel", bpm: 120, file: "Canciones/Madrugadas - Jensen & Myguel_120bpm.mp3" },
    { name: "Mamacita - Mickey Then", bpm: 130, file: "Canciones/Mamacita - Mickey Then_130bpm_1al8_x12.mp3" },
    { name: "Me Preguntaron Por Ti - SP Polanco & Sebas Garreta", bpm: 128, file: "Canciones/Me Preguntaron Por Ti - SP Polanco & Sebas Garreta_128bpm_1al8_x10.mp3" },
    { name: "Millonario - Pinto Picasso & Dani J", bpm: 128, file: "Canciones/Millonario - Pinto Picasso & Dani J_128bpm_1al8_x12.mp3" },
    // { name: "No Soy Bueno Para Ti - Mickey Then", bpm: 131, file: "Canciones/No Soy Bueno Para Ti - Mickey Then_131bpm_1al8_x16.mp3" },
    { name: "Oxígeno - SHAMA, Dimelo Cupido & DJ Husky", bpm: 123, file: "Canciones/Oxígeno - SHAMA, Dimelo Cupido & DJ Husky_123bpm_1al8_x14.mp3" },
    // { name: "Proceso - SP Polanco & Super Joell", bpm: 131, file: "Canciones/Proceso - SP Polanco & Super Joell_130bpm_1al8_x18.mp3" },
    { name: "Puedo Enamorarte - Mickey Then", bpm: 139, file: "Canciones/Puedo Enamorarte - Mickey Then_139bpm_1al8_x12.mp3" },
    // { name: "Que Se Parezca A Ti (Bachata Version) - DJ Clau & Román", bpm: 105, file: "Canciones/Que Se Parezca A Ti (Bachata Version) - DJ Clau & Román_104bpm.mp3" },
    { name: "Sabanas Mojadas - Jensen", bpm: 100, file: "Canciones/Sabanas Mojadas - Jensen_100bpm_1al8_x10.mp3" },
    { name: "Secreto De Locos - DJ Tronky, Jensen & Mayinbito", bpm: 108, file: "Canciones/Secreto De Locos - DJ Tronky, Jensen & Mayinbito_108bpm.mp3" },
    // { name: "Señor Juez - Ozuna & Anthony Santos", bpm: 129, file: "Canciones/Señor Juez - Ozuna & Anthony Santos_130bpm_1al8_x12.mp3" },
    // { name: "Si Supieras - Prince Royce", bpm: 120, file: "Canciones/Si Supieras - Prince Royce_120bpm_1al8_x20.mp3" },
    // { name: "Super Héroe - Tony Dize", bpm: 135, file: "Canciones/Super Héroe - Tony Dize_131bpm_1al8_x12.mp3" },
    // { name: "Volcán - SHAMA", bpm: 121, file: "Canciones/Volcán - SHAMA_120bpm_1al8_x12.mp3" }
];

// ===== ESTADOS GLOBALES =====
let isPlaying = false;
let isFirstAction = true;
let currentFigureValue = null;
// Dimensión que van a mover las flechas ↑/↓: se actualiza cada vez que el
// usuario toca (elige algo, o pone en "Cualquiera") alguno de los 3
// desplegables. Arranca en 'figura' porque es el comportamiento por defecto
// al recién cargar la página.
let ultimaDimensionSeleccionada = 'figura'; // 'figura' | 'posIni' | 'posFin'
let currentSongValue = "";
let currentDificultadValue = "D1";
let currentVariantIndex = 0; // qué toma (variante) dentro de figurasData[fig][niv] se está mostrando
let loadSequence = 0;
// Toggle "T": muestra un cartel extra debajo de Posición Final con el número
// inicial y las 3 letras finales del archivo de video correspondiente.
let mostrarTitulo = (localStorage.getItem('mostrarTitulo') !== '0');

const audioPlayer = document.getElementById('audio-player');
audioPlayer.addEventListener('error', () => {
    if (window.reportMediaError) window.reportMediaError('audio', audioPlayer.src, audioPlayer.error);
});
const rateInput = document.getElementById('rate-input');
const bpmLabel = document.getElementById('calc-bpm-label');
const playBtn = document.getElementById('play-btn');
const playIcon = document.getElementById('play-icon');
const loadingIndicator = document.getElementById('loading-indicator');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const pageIndicator = document.getElementById('page-indicator');
const videoGridWrapper = document.getElementById('video-grid-wrapper');
const videoPrevBtn = document.getElementById('video-prev-btn');
const videoNextBtn = document.getElementById('video-next-btn');

function safeUrl(path) { return encodeURI(path); }

// Extrae del nombre de archivo (ej. "Figuras/028_..._D3_UQX_8t.mp4") el
// número del principio ("028") y las 3 letras del final ("UQX"), para
// mostrarlos en el cartel opcional del toggle "T".
function extraerInfoArchivo(filePath) {
    if (!filePath) return null;
    const nombre = filePath.split('/').pop();
    const match = nombre.match(/^(\d+)_.*_([A-Za-z]{3})_\d+t\.[^.]+$/);
    if (!match) return null;
    return { numero: match[1], letras: match[2] };
}

// Safari/iOS resetea silenciosamente playbackRate a 1.0 cuando un <video>
// termina de cargar metadata o arranca a reproducir, aunque ya lo hayas seteado antes.
// Por eso hace falta guardar el rate calculado y "re-clavarlo" en varios eventos.
let currentVideoRate = 1.0;
function aplicarRateAVideos() {
    getAllVideos().forEach(v => { v.playbackRate = currentVideoRate; });
}

// ===== COOKIES =====
function setCookie(name, value, days = 365) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}
function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
}

// ===== AYUDA: PRIMER CANCION DEL SORT ACTIVO =====
function getPrimeraCancionSortActivo() {
    const sortActive = document.getElementById('sort-abc').classList.contains('active') ? 'abc' : 'bpm';
    let sorted = [...canciones];
    if (sortActive === 'abc') {
        sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        sorted.sort((a, b) => a.bpm - b.bpm);
    }
    return sorted[0] || null;
}

function forzarPrimeraCancionYReiniciar() {
    if (!isFirstAction) return;
    const primera = getPrimeraCancionSortActivo();
    if (!primera) return;
    currentSongValue = primera.file;
    localStorage.setItem('lastSong', currentSongValue);
    setDropdownSelectedHTML('song-selected', `🎧 ${primera.name} [${primera.bpm} BPM]`);
    const sortActive = document.getElementById('sort-abc').classList.contains('active') ? 'abc' : 'bpm';
    renderSongList(document.getElementById('song-search').value, sortActive);
    prepararFuentes();
    actualizarVelocidades();
    renderGrid();
}

// ===== RENDERIZADO DE GRILLA =====
// Ya no hay "páginas" de tomas dentro de un mismo combo: se muestran TODAS las
// tomas de la Dificultad elegida juntas, en la grilla más chica que las
// contenga a todas (hasta 4x4 = 16). Si esa dificultad tiene más tomas de las
// que entran en la grilla más grande, las sobrantes no se muestran.
function renderGrid() {
    // Si no hay ningún Movimiento que cumpla los filtros/toggles activos
    // (por ejemplo, "I" y "C" desactivados a la vez), se muestra un aviso
    // en vez de dejar la grilla vacía o con el último video que quedó.
    const pasosActuales = construirPasosFiltrados();
    if (pasosActuales.length === 0) {
        videoGridWrapper.innerHTML = '';
        const aviso = document.createElement('div');
        aviso.id = 'sin-movimientos-aviso';
        aviso.innerText = 'No hay Movimientos para mostrar';
        videoGridWrapper.appendChild(aviso);
        return;
    }

    const fig = currentFigureValue;
    const niv = currentDificultadValue;
    if (!fig || !niv || !figurasData[fig] || !figurasData[fig][niv]) return;

    const todasLasTomas = figurasData[fig][niv];
    if (!todasLasTomas || todasLasTomas.length === 0) return;
    // Cada Dificultad/variante es un paso distinto de la navegación: se muestra
    // UNA sola toma por vez (la señalada por currentVariantIndex), no todas juntas.
    const idxVariante = Math.min(currentVariantIndex, todasLasTomas.length - 1);
    const items = [todasLasTomas[idxVariante]];
    const totalItems = items.length;

    const tier = getGridTierParaCount(totalItems);
    const pageItems = items.slice(0, tier.perPage);
    const startIdx = 0;

    // Número de página real (1-based) dentro del total de tomas filtradas,
    // para que "Movimiento X" coincida con el contador de arriba (1/101, etc.).
    let idxPasoActual = indicePasoActual(pasosActuales);
    if (idxPasoActual === -1) idxPasoActual = 0;
    const numeroMovimiento = idxPasoActual + 1;

    videoGridWrapper.innerHTML = '';
    videoGridWrapper.appendChild(loadingIndicator);

    const grid = document.createElement('div');
    grid.className = `video-grid grid-${tier.cols}x${tier.rows}`;

    pageItems.forEach((item, idx) => {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.index = startIdx + idx;

        const label = document.createElement('div');
        label.className = 'movement-label';
        label.innerText = `Movimiento ${numeroMovimiento}/${pasosActuales.length}`;
        cell.appendChild(label);

        // ===== OVERLAY CENTRAL: Figura / Posición Inicial / Posición Final =====
        // Muestra el combo del video actual (no cambia con la Dificultad ni la
        // variante, así que es el mismo para toda la página). Los valores ""
        // (figuras/posiciones sin nombre propio, "---" en el archivo) se
        // muestran como "---" para que igual quede claro que hay un video ahí.
        const comboActual = comboByKey[fig] || {};
        const mostrarValor = (v) => (v === '' || v === undefined || v === null) ? '---' : v;

        const centerOverlay = document.createElement('div');
        centerOverlay.className = 'figure-center-overlay';

        const dificultadBadge = document.createElement('div');
        dificultadBadge.className = `info-badge info-badge-dificultad${filterDificultad !== null ? ' info-badge-filtro-activo' : ''}`;
        dificultadBadge.innerText = mostrarValor(niv);
        dificultadBadge.title = 'Fijar / quitar filtro de Dificultad';
        dificultadBadge.onclick = (e) => { e.stopPropagation(); fijarFiltroDesdeVideoActual('dificultad'); };
        centerOverlay.appendChild(dificultadBadge);

        const posIniBadge = document.createElement('div');
        posIniBadge.className = `info-badge info-badge-posini${filterPosIni !== null ? ' info-badge-filtro-activo' : ''}`;
        posIniBadge.innerText = mostrarValor(comboActual.posIni);
        posIniBadge.title = 'Fijar / quitar filtro de Posición Inicial';
        posIniBadge.onclick = (e) => { e.stopPropagation(); fijarFiltroDesdeVideoActual('posIni'); };
        centerOverlay.appendChild(posIniBadge);

        const figuraBadge = document.createElement('div');
        figuraBadge.className = `info-badge info-badge-figura${filterFigura !== null ? ' info-badge-filtro-activo' : ''}`;
        figuraBadge.innerText = mostrarValor(comboActual.figura);
        figuraBadge.title = 'Fijar / quitar filtro de Figura';
        figuraBadge.onclick = (e) => { e.stopPropagation(); fijarFiltroDesdeVideoActual('figura'); };
        centerOverlay.appendChild(figuraBadge);

        const posFinBadge = document.createElement('div');
        posFinBadge.className = `info-badge info-badge-posfin${filterPosFin !== null ? ' info-badge-filtro-activo' : ''}`;
        posFinBadge.innerText = mostrarValor(comboActual.posFin);
        posFinBadge.title = 'Fijar / quitar filtro de Posición Final';
        posFinBadge.onclick = (e) => { e.stopPropagation(); fijarFiltroDesdeVideoActual('posFin'); };
        centerOverlay.appendChild(posFinBadge);

        cell.appendChild(centerOverlay);

        // ===== CÍRCULOS DE FIGURA: uno por cada parte (o uno solo si es
        // singular) =====
        // Si la Figura del video actual es singular, un solo círculo con su
        // primera letra. Si es compuesta ("A + B"), un círculo por cada
        // parte, cada uno con la primera letra de esa parte. Clickear cada
        // uno fija/quita el filtro de Figura con ese componente puntual.
        if (typeof comboActual.figura === 'string' && comboActual.figura !== '') {
            const partesFigura = componentesDeFigura(comboActual.figura);
            const grupoCirculosFigura = document.createElement('div');
            grupoCirculosFigura.className = 'figura-circle-group';
            partesFigura.forEach(parte => {
                const circuloFigura = document.createElement('button');
                const circuloActivo = esFiltroTexto(filterFigura)
                    ? contieneTodasLasPalabras(parte, filterFigura.original)
                    : filterFigura === parte;
                circuloFigura.className = `figura-circle${circuloActivo ? ' figura-circle-activo' : ''}`;
                circuloFigura.innerText = parte.charAt(0).toUpperCase();
                circuloFigura.title = `Fijar / quitar filtro de Figura: ${parte}`;
                circuloFigura.onclick = (e) => { e.stopPropagation(); fijarFiltroFiguraComponente(parte); };
                grupoCirculosFigura.appendChild(circuloFigura);
            });
            cell.appendChild(grupoCirculosFigura);
        }

        // Cartel opcional (toggle "T"): el código identificador del archivo de
        // video actual, partido en 2 y a la misma altura que "Movimiento X/X"
        // (arriba del video): el número a la izquierda, las 3 letras a la derecha.
        if (mostrarTitulo) {
            const infoArchivo = extraerInfoArchivo(item.file8t);
            if (infoArchivo) {
                const badgeNumero = document.createElement('div');
                badgeNumero.className = 'titulo-side-badge titulo-side-left';
                badgeNumero.innerText = infoArchivo.numero;
                cell.appendChild(badgeNumero);

                const badgeLetras = document.createElement('div');
                badgeLetras.className = 'titulo-side-badge titulo-side-right';
                badgeLetras.innerText = infoArchivo.letras;
                cell.appendChild(badgeLetras);
            }
        }

        const vid8t = document.createElement('video');
        vid8t.className = 'vid-visible';
        vid8t.muted = true;
        vid8t.playsInline = true;
        vid8t.preload = 'auto';
        vid8t.dataset.role = 'main';
        // Necesario para que el Service Worker pueda interceptar y servir
        // bien este pedido (sobre todo los que llevan header Range) — sin
        // esto, el video puede quedarse esperando red aunque ya esté cacheado.
        // (crossOrigin='anonymous' se probó acá y se sacó: como la respuesta
        // la arma el Service Worker a mano para servir Range, el navegador
        // terminaba rechazándola por CORS — SRC_NOT_SUPPORTED — en vez de
        // aceptarla. Mismo origen no lo necesita.)
        vid8t.src = safeUrl(item.file8t);
        vid8t.addEventListener('error', () => window.reportMediaError('video8t', vid8t.src, vid8t.error));

        const vid7t = document.createElement('video');
        vid7t.className = 'vid-hidden';
        vid7t.muted = true;
        vid7t.playsInline = true;
        vid7t.preload = 'auto';
        vid7t.loop = true;
        vid7t.dataset.role = 'loop';
        vid7t.src = safeUrl(item.file7t);
        vid7t.addEventListener('error', () => window.reportMediaError('video7t', vid7t.src, vid7t.error));

        vid8t.addEventListener('ended', () => {
            vid8t.className = 'vid-hidden';
            vid7t.className = 'vid-visible';
            vid7t.currentTime = 0;
            vid7t.play().then(aplicarRateAVideos).catch(() => {});
        });

        ['loadedmetadata', 'canplay', 'playing'].forEach(evt => {
            vid8t.addEventListener(evt, aplicarRateAVideos);
            vid7t.addEventListener(evt, aplicarRateAVideos);
        });

        cell.addEventListener('click', () => {
            playBtn.click();
        });

        cell.appendChild(vid8t);
        cell.appendChild(vid7t);
        grid.appendChild(cell);
    });

    videoGridWrapper.appendChild(grid);
    actualizarVelocidades();
    actualizarPaginacion();

    if (!isPlaying) {
        grid.querySelectorAll('video[data-role="main"]').forEach(v => {
            v.play().catch(() => {});
        });
    }
}

function getAllMainVideos() {
    return Array.from(videoGridWrapper.querySelectorAll('video[data-role="main"]'));
}
function getAllLoopVideos() {
    return Array.from(videoGridWrapper.querySelectorAll('video[data-role="loop"]'));
}
function getAllVideos() {
    return Array.from(videoGridWrapper.querySelectorAll('video'));
}

// ===== DROPDOWNS =====
// Arma (si corresponde) el ítem especial "🔎 Todas las que contengan..." que
// encabeza la lista de un desplegable buscable, cuando hay texto tipeado:
// clickearlo (o Enter estando el campo enfocado, sin haber resaltado ningún
// otro ítem con las flechas) aplica el texto tal cual como filtro de "texto
// libre" — ver aplicarFiltroTextoLibre. cantidadCoincidencias es la cantidad
// de Movimientos que ya cumplen el resto de filtros activos Y contienen ese
// texto, para que se vea de antemano cuántos van a quedar.
function htmlItemTextoLibre(searchTerm, cantidadCoincidencias, filtroActivo) {
    const original = (searchTerm || '').trim();
    if (original === '') return '';
    const activo = esFiltroTexto(filtroActivo) && filtroActivo.texto === normalizarTexto(original);
    const plural = cantidadCoincidencias === 1 ? '' : 's';
    return `<div class="dropdown-item dropdown-item-texto-libre ${activo ? 'selected' : ''}" data-textolibre="1">
        🔎 Todas las que contengan "${escaparHtml(original)}" (${cantidadCoincidencias} resultado${plural})
    </div>`;
}

function escaparHtml(texto) {
    return (texto || '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderFigureList(searchTerm = "") {
    const listEl = document.getElementById('fig-list');
    const candidatos = combosFiltrados('figura');
    const etiquetaFigura = (f) => (f === '' ? '---' : f);
    // Se incluye tanto la figura completa (por si es compuesta y se la quiere
    // elegir tal cual) como cada uno de sus movimientos por separado, para
    // poder elegir "Gancho" o "Traslado" individualmente aunque sólo existan
    // como parte de "Gancho + Traslado".
    const valorSet = new Set();
    candidatos.forEach(c => {
        valorSet.add(c.figura);
        componentesDeFigura(c.figura).forEach(p => valorSet.add(p));
    });
    const terminoNormalizado = normalizarTexto(searchTerm).trim();
    const valores = [...valorSet]
        .filter(f => contieneTodasLasPalabras(etiquetaFigura(f), searchTerm))
        .sort((a, b) => etiquetaFigura(a).localeCompare(etiquetaFigura(b)));

    // El ítem "Cualquier Figura" usa data-any="1" (en vez de data-value="")
    // para no confundirse con la figura real de valor "" (las que en el
    // nombre de archivo llevan "---" y se muestran acá también como "---").
    let html = `<div class="dropdown-item ${filterFigura === null ? 'selected' : ''}" data-any="1">💃 Cualquier Figura [🌈]</div>`;
    if (terminoNormalizado !== '') {
        const cantidad = candidatos.filter(c => contieneTodasLasPalabras(c.figura, searchTerm)).length;
        html += htmlItemTextoLibre(searchTerm, cantidad, filterFigura);
    }
    if (valores.length > 0) {
        html += valores.map(f => `
            <div class="dropdown-item ${f === filterFigura ? 'selected' : ''}" data-value="${f}">
                💃 ${etiquetaFigura(f)}
            </div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item[data-textolibre]').forEach(item => {
        item.onclick = () => aplicarFiltroTextoLibre('figura', searchTerm);
    });
    listEl.querySelectorAll('.dropdown-item[data-any], .dropdown-item[data-value]').forEach(item => {
        item.onclick = () => {
            filterFigura = item.dataset.any === '1' ? null : item.dataset.value;
            ultimaDimensionSeleccionada = 'figura';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
        };
    });
}

function renderPosIniList(searchTerm = "") {
    const listEl = document.getElementById('posini-list');
    const candidatos = combosFiltrados('posIni');
    const etiquetaPos = (p) => (p === '' ? '---' : p);
    const terminoNormalizadoIni = normalizarTexto(searchTerm).trim();
    const valores = [...new Set(candidatos.map(c => c.posIni).filter(v => typeof v === 'string'))]
        .filter(p => contieneTodasLasPalabras(etiquetaPos(p), searchTerm))
        .sort((a, b) => etiquetaPos(a).localeCompare(etiquetaPos(b)));

    // "Cualquier Posición Inicial" usa data-any="1" (en vez de data-value="")
    // para no confundirse con la posición real de valor "" (las que se
    // muestran acá como "---").
    let html = `<div class="dropdown-item ${filterPosIni === null ? 'selected' : ''}" data-any="1"><span class="pos-dot pos-dot-ini"></span>Cualquier Posición Inicial [🌈]</div>`;
    if (terminoNormalizadoIni !== '') {
        const cantidad = candidatos.filter(c => contieneTodasLasPalabras(c.posIni, searchTerm)).length;
        html += htmlItemTextoLibre(searchTerm, cantidad, filterPosIni);
    }
    if (valores.length > 0) {
        html += valores.map(p => `
            <div class="dropdown-item ${p === filterPosIni ? 'selected' : ''}" data-value="${p}"><span class="pos-dot pos-dot-ini"></span>${etiquetaPos(p)}</div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item[data-textolibre]').forEach(item => {
        item.onclick = () => aplicarFiltroTextoLibre('posIni', searchTerm);
    });
    listEl.querySelectorAll('.dropdown-item[data-any], .dropdown-item[data-value]').forEach(item => {
        item.onclick = () => {
            filterPosIni = item.dataset.any === '1' ? null : item.dataset.value;
            // Con "=" activado, Posición Inicial y Final van siempre atadas:
            // al elegir una, la otra pasa a valer exactamente lo mismo.
            if (filtroPosIgual) filterPosFin = filterPosIni;
            ultimaDimensionSeleccionada = 'posIni';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
        };
    });
}

function renderPosFinList(searchTerm = "") {
    const listEl = document.getElementById('posfin-list');
    const candidatos = combosFiltrados('posFin');
    const etiquetaPos = (p) => (p === '' ? '---' : p);
    const terminoNormalizadoFin = normalizarTexto(searchTerm).trim();
    const valores = [...new Set(candidatos.map(c => c.posFin).filter(v => typeof v === 'string'))]
        .filter(p => contieneTodasLasPalabras(etiquetaPos(p), searchTerm))
        .sort((a, b) => etiquetaPos(a).localeCompare(etiquetaPos(b)));

    let html = `<div class="dropdown-item ${filterPosFin === null ? 'selected' : ''}" data-any="1"><span class="pos-dot pos-dot-fin"></span>Cualquier Posición Final [🌈]</div>`;
    if (terminoNormalizadoFin !== '') {
        const cantidad = candidatos.filter(c => contieneTodasLasPalabras(c.posFin, searchTerm)).length;
        html += htmlItemTextoLibre(searchTerm, cantidad, filterPosFin);
    }
    if (valores.length > 0) {
        html += valores.map(p => `
            <div class="dropdown-item ${p === filterPosFin ? 'selected' : ''}" data-value="${p}"><span class="pos-dot pos-dot-fin"></span>${etiquetaPos(p)}</div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item[data-textolibre]').forEach(item => {
        item.onclick = () => aplicarFiltroTextoLibre('posFin', searchTerm);
    });
    listEl.querySelectorAll('.dropdown-item[data-any], .dropdown-item[data-value]').forEach(item => {
        item.onclick = () => {
            filterPosFin = item.dataset.any === '1' ? null : item.dataset.value;
            // Idem: con "=" activado, fijar Posición Final también fija la
            // Posición Inicial al mismo valor.
            if (filtroPosIgual) filterPosIni = filterPosFin;
            ultimaDimensionSeleccionada = 'posFin';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
        };
    });
}

// Saca tildes/diacríticos y pasa a minúsculas, para que buscar "Oxigeno"
// encuentre "Oxígeno".
function normalizarTexto(texto) {
    return (texto || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

// Búsqueda de "texto libre" multi-palabra (estilo __Reordenador.py): la
// query se separa en palabras por espacios y se exige que TODAS aparezcan
// (en cualquier orden, no necesariamente pegadas) en el texto objetivo, sin
// importar tildes/mayúsculas. Así, escribir "gancho traslado" encuentra
// tanto "Gancho + Traslado" como "Traslado + Gancho", permitiendo combinar
// varios movimientos en una sola búsqueda en vez de tener que escribirlos
// en el orden y formato exactos en que aparecen.
function contieneTodasLasPalabras(textoObjetivo, query) {
    const palabras = normalizarTexto(query).trim().split(/\s+/).filter(Boolean);
    if (palabras.length === 0) return true;
    const texto = normalizarTexto(textoObjetivo);
    return palabras.every(p => texto.includes(p));
}

function renderSongList(searchTerm = "", sortType = "abc") {
    const listEl = document.getElementById('song-list');
    const terminoNormalizado = normalizarTexto(searchTerm).trim();
    let filtered = canciones.filter(c => {
        if (terminoNormalizado === '') return true;
        if (normalizarTexto(c.name).includes(terminoNormalizado)) return true;
        // También se puede buscar por BPM (ej: escribir "128" encuentra las
        // canciones que están a 128 BPM).
        if (c.bpm.toString().includes(terminoNormalizado)) return true;
        return false;
    });
    if (sortType === 'abc') {
        filtered.sort((a, b) => a.name.localeCompare(b.name));
    } else {
        filtered.sort((a, b) => a.bpm - b.bpm);
    }
    if (filtered.length === 0) {
        listEl.innerHTML = '';
        return;
    }
    listEl.innerHTML = filtered.map(c => `
        <div class="dropdown-item ${c.file === currentSongValue ? 'selected' : ''}" data-value="${c.file}">
            🎧 ${c.name} [${c.bpm} BPM]
        </div>
    `).join('');
    listEl.querySelectorAll('.dropdown-item[data-value]').forEach(item => {
        item.onclick = () => {
            currentSongValue = item.dataset.value;
            localStorage.setItem('lastSong', currentSongValue);
            setDropdownSelectedHTML('song-selected', item.innerHTML);
            closeAllDropdowns();
            if (isPlaying || !isFirstAction) mutearParaCarga();
            audioPlayer.pause();
            prepararFuentes();
            if (isPlaying) {
                reiniciarDesdeCero(true);
            } else {
                isFirstAction = true;
                renderGrid();
            }
        };
    });
}

// Dificultad (antes "MaxH"): ahora es un filtro más, igual que Figura/Posición.
// Las opciones que se ofrecen dependen de los combos que ya cumplen los demás
// filtros activos (misma lógica de "autofiltrado" que las otras 3 listas).
function renderDificultadList() {
    const listEl = document.getElementById('ver-list');
    const niveles = nivelesDificultadDisponibles();

    let html = `<div class="dropdown-item ${filterDificultad === null ? 'selected' : ''}" data-value="">🌈</div>`;
    html += niveles.map(d => `
        <div class="dropdown-item ${d === filterDificultad ? 'selected' : ''}" data-value="${d}">${d}</div>
    `).join('');
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item[data-value]').forEach(item => {
        item.onclick = () => {
            if (isPlaying || !isFirstAction) mutearParaCarga();
            ultimaDimensionSeleccionada = 'dificultad';
            filterDificultad = item.dataset.value === '' ? null : item.dataset.value;
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
        };
    });
}

// opts.skipSync: no tocar el historial del navegador acá (lo usa
// toggleDropdown, que sincroniza una sola vez al final, después de cerrar Y
// de eventualmente volver a abrir — ver más abajo).
function closeAllDropdowns(opts) {
    document.getElementById('fig-options-panel').style.display = 'none';
    document.getElementById('song-options-panel').style.display = 'none';
    document.getElementById('ver-options-panel').style.display = 'none';
    document.getElementById('posini-options-panel').style.display = 'none';
    document.getElementById('posfin-options-panel').style.display = 'none';
    document.getElementById('menu-options-panel').style.display = 'none';
    document.getElementById('movsearch-options-panel').style.display = 'none';
    document.getElementById('fav-list-options-panel').style.display = 'none';

    // Al cerrarse (desclickeado), sólo se borra lo escrito en el buscador de
    // Canción. Los buscadores de Figura, Posición Inicial, Posición Final y
    // Movimiento (🔍 / L) MANTIENEN el texto buscado la próxima vez que se
    // abran (ver los onclick de sus "selected"/botón, que ya renderizan con
    // el valor actual del input), hasta que se resetee esa dimensión con su
    // ↺, con 🌈/F, o se lo reemplace escribiendo de cero.
    const songSearchInput = document.getElementById('song-search');
    if (songSearchInput) songSearchInput.value = '';

    if (!opts || !opts.skipSync) sincronizarHistorialOverlay();
}

// Si el panel pasado ya estaba abierto, clickear su mismo botón lo cierra
// (igual que clickear afuera), en vez de volver a abrirlo.
function toggleDropdown(panelId, openFn) {
    const panel = document.getElementById(panelId);
    const yaEstabaAbierto = panel.style.display === 'flex';
    closeAllDropdowns({ skipSync: true });
    if (!yaEstabaAbierto) {
        panel.style.display = 'flex';
        if (openFn) openFn();
    }
    // Se sincroniza una sola vez acá, ya con el estado final asentado (abierto
    // otro desplegable distinto, o cerrado del todo) — así cambiar de un
    // desplegable a otro no hace un "cerrar + abrir" en el historial (que
    // dejaría entradas de más), sino que no toca el historial si seguimos
    // con algo abierto todo el tiempo.
    sincronizarHistorialOverlay();
}

// ===== BOTÓN "ATRÁS" DEL TELÉFONO: cierra desplegables/menús en vez de salir =====
// Cada vez que se abre un desplegable (Figura, Canción, Dificultad, Posición
// Inicial/Final, el menú ☰, el buscador de Movimiento, la lista de
// Favoritos) o el modal de Atajos de teclado, se agrega una entrada extra al
// historial del navegador. Así, si el usuario presiona "atrás" (el botón
// físico/gesto del teléfono) con alguno de esos abiertos, en vez de salir de
// la app lo que hace es "gastar" esa entrada extra: el evento popstate
// cierra el desplegable/modal y la app se queda donde estaba. Si se cierra
// de la forma normal (clickeando afuera, eligiendo una opción, la X, etc.),
// se vuelve atrás en el historial en silencio para sacar esa entrada extra,
// así la PRÓXIMA vez que se presione "atrás" si actúa como atrás real.
let overlayHistoryPushed = false;

// Todos los paneles que cierra closeAllDropdowns() (incluye el menú ☰, que
// no tiene lista navegable por teclado y por eso no está en
// DROPDOWN_PANEL_TO_LIST — hay que chequearlo aparte).
const PANELES_MENU_TODOS = [
    'fig-options-panel', 'song-options-panel', 'ver-options-panel',
    'posini-options-panel', 'posfin-options-panel', 'menu-options-panel',
    'movsearch-options-panel', 'fav-list-options-panel',
];

function hayAlgunOverlayAbierto() {
    if (PANELES_MENU_TODOS.some(id => {
        const el = document.getElementById(id);
        return el && el.style.display === 'flex';
    })) return true;
    const hotkeysModal = document.getElementById('hotkeys-modal-overlay');
    return !!(hotkeysModal && hotkeysModal.style.display === 'flex');
}

function sincronizarHistorialOverlay() {
    const abierto = hayAlgunOverlayAbierto();
    if (abierto && !overlayHistoryPushed) {
        overlayHistoryPushed = true;
        history.pushState({ overlayGlosario: true }, '');
    } else if (!abierto && overlayHistoryPushed) {
        overlayHistoryPushed = false;
        history.back();
    }
}

window.addEventListener('popstate', () => {
    // Si no habíamos agregado nosotros esa entrada, este "atrás" es un atrás
    // real de la navegación (no nuestro): no hay nada que cerrar acá.
    if (!overlayHistoryPushed) return;
    overlayHistoryPushed = false;
    closeAllDropdowns({ skipSync: true });
    const hotkeysModal = document.getElementById('hotkeys-modal-overlay');
    if (hotkeysModal) hotkeysModal.style.display = 'none';
});

// ===== NAVEGACIÓN POR TECLADO DENTRO DE UN DESPLEGABLE ABIERTO =====
// Mapa panel -> lista, para saber cuál está abierto y sobre qué lista mover
// el resaltado con Flecha Arriba / Flecha Abajo, y confirmar con Enter.
const DROPDOWN_PANEL_TO_LIST = {
    'fig-options-panel': 'fig-list',
    'posini-options-panel': 'posini-list',
    'posfin-options-panel': 'posfin-list',
    'ver-options-panel': 'ver-list',
    'song-options-panel': 'song-list',
    'movsearch-options-panel': 'movsearch-list',
    'fav-list-options-panel': 'fav-list-list',
};

// Sólo estos desplegables soportan el filtro de "texto libre" al apretar
// Enter sin nada resaltado (ver aplicarFiltroTextoLibre). Figura / Posición
// Inicial / Posición Final lo aplican sobre su propia dimensión; el
// buscador de Movimiento (🔍, L) —que busca por texto libre combinando
// Dificultad + Posición Inicial + Figura + Posición Final— lo aplica sobre
// su PROPIO filtro (filterMovSearchTexto, vía aplicarFiltroTextoLibreMovSearch),
// separado del de Figura, para que la búsqueda quede en la Lupa y no en el
// menú de Figuras. Canción, Dificultad y Favoritos siguen funcionando como antes.
const PANEL_A_FILTRO_TEXTO_LIBRE = {
    'fig-options-panel': { dimension: 'figura', inputId: 'fig-search' },
    'posini-options-panel': { dimension: 'posIni', inputId: 'posini-search' },
    'posfin-options-panel': { dimension: 'posFin', inputId: 'posfin-search' },
    'movsearch-options-panel': { dimension: 'movsearch', inputId: 'movsearch-search' },
};

// Devuelve {panelId, listId} del desplegable de filtro/canción que esté
// abierto en este momento, o null si ninguno lo está.
function getOpenDropdown() {
    for (const panelId in DROPDOWN_PANEL_TO_LIST) {
        const panel = document.getElementById(panelId);
        if (panel && panel.style.display === 'flex') {
            return { panelId, listId: DROPDOWN_PANEL_TO_LIST[panelId] };
        }
    }
    return null;
}

// Mueve el resaltado (sin todavía aplicar el filtro) un paso hacia arriba o
// abajo dentro de la lista indicada. Si no había nada resaltado, arranca
// desde el ítem ya "seleccionado" (el filtro activo) para que la primera
// flecha mueva hacia un lado coherente en vez de saltar a un extremo.
function navigateDropdownHighlight(listId, direccion) {
    const list = document.getElementById(listId);
    if (!list) return;
    const items = Array.from(list.querySelectorAll('.dropdown-item'));
    if (items.length === 0) return;

    let idx = items.findIndex(it => it.classList.contains('kbd-highlight'));
    if (idx === -1) {
        const idxSeleccionado = items.findIndex(it => it.classList.contains('selected'));
        idx = idxSeleccionado !== -1 ? idxSeleccionado : (direccion > 0 ? -1 : 0);
    }
    items.forEach(it => it.classList.remove('kbd-highlight'));

    idx += direccion;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;

    items[idx].classList.add('kbd-highlight');
    items[idx].scrollIntoView({ block: 'nearest' });
}

// Enter: confirma (clickea) el ítem resaltado por teclado, si hay alguno.
function confirmDropdownHighlight(listId) {
    const list = document.getElementById(listId);
    if (!list) return;
    const resaltado = list.querySelector('.dropdown-item.kbd-highlight');
    if (resaltado) resaltado.click();
}

document.getElementById('posini-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('posini-options-panel', () => {
        renderPosIniList(document.getElementById('posini-search').value);
        document.getElementById('posini-search').focus();
    });
};
document.getElementById('posfin-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('posfin-options-panel', () => {
        renderPosFinList(document.getElementById('posfin-search').value);
        document.getElementById('posfin-search').focus();
    });
};
document.getElementById('posini-options-panel').onclick = e => e.stopPropagation();
document.getElementById('posfin-options-panel').onclick = e => e.stopPropagation();

document.getElementById('fig-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('fig-options-panel', () => {
        renderFigureList(document.getElementById('fig-search').value);
        document.getElementById('fig-search').focus();
    });
};

document.getElementById('song-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('song-options-panel', () => {
        const sortActive = document.getElementById('sort-abc').classList.contains('active') ? 'abc' : 'bpm';
        renderSongList(document.getElementById('song-search').value, sortActive);
        document.getElementById('song-search').focus();
    });
};

document.getElementById('ver-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('ver-options-panel', () => renderDificultadList());
};

// ===== BOTONES DE RESET RÁPIDO (🌈) =====
// Ponen esa dimensión en "Cualquiera" directamente, sin tener que abrir el
// desplegable y buscar la opción.
document.getElementById('fig-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'figura';
    document.getElementById('fig-search').value = '';
    if (filterFigura === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterFigura = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
// ===== TOGGLES "I" (Individuales) Y "C" (Combos) DE FIGURA =====
// Los dos filtran qué tomas existen en toda la app (no solo el
// desplegable de Figura), así que ambos recalculan todo igual que al
// cambiar cualquier otro filtro (puede hacer que el combo actualmente
// mostrado deje de existir).
document.getElementById('fig-individualizar-btn').onclick = (e) => {
    e.stopPropagation();
    if (isPlaying || !isFirstAction) mutearParaCarga();
    mostrarFigurasIndividuales = !mostrarFigurasIndividuales;
    localStorage.setItem('mostrarFigurasIndividuales', mostrarFigurasIndividuales ? '1' : '0');
    document.getElementById('fig-individualizar-btn').classList.toggle('active', mostrarFigurasIndividuales);
    renderFigureList(document.getElementById('fig-search').value);
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
document.getElementById('fig-combos-btn').onclick = (e) => {
    e.stopPropagation();
    if (isPlaying || !isFirstAction) mutearParaCarga();
    mostrarCombos = !mostrarCombos;
    localStorage.setItem('mostrarCombos', mostrarCombos ? '1' : '0');
    document.getElementById('fig-combos-btn').classList.toggle('active', mostrarCombos);
    renderFigureList(document.getElementById('fig-search').value);
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
// ¿Activar "=" ahora mismo dejaría al menos un Movimiento visible, dados los
// demás filtros ya puestos (Figura, Dificultad, Posición Inicial)? Simula la
// misma normalización que hace el propio botón al activarse (si Posición
// Inicial y Final difieren, Final pasa a valer lo mismo que Inicial), así
// que alcanza con exigir c.posIni === c.posFin y, si había una Posición
// Inicial fijada, que coincida con ella (la Final, tras la normalización,
// pide exactamente lo mismo, por eso no hace falta chequearla aparte).
function puedeActivarPosIgual() {
    if (filtroPosIgual) return true; // ya activo: siempre se puede desactivar
    if (combosData.length === 0) return true; // todavía no cargó nada: no bloquear de arranque
    const hiddenSteps = mostrarFigurasOcultas ? [] : getHiddenSteps();
    return combosData.some(c => {
        if (typeof c.figura === 'string') {
            const esCombo = c.figura.includes('+');
            if (esCombo && !mostrarCombos) return false;
            if (!esCombo && !mostrarFigurasIndividuales) return false;
        }
        if (c.posIni !== c.posFin) return false;
        if (filterFigura !== null && !comboCoincideFigura(c, filterFigura)) return false;
        if (filterPosIni !== null && !coincideValorPos(c.posIni, filterPosIni)) return false;
        if (filterDificultad !== null && !(c.dificultades && c.dificultades[filterDificultad] && c.dificultades[filterDificultad].length)) return false;
        if (!comboTieneTomaVisible(c, hiddenSteps, filterDificultad)) return false;
        return true;
    });
}

// Refresca la inhabilitación visual del botón "=": si no está activo y
// activarlo no dejaría ningún Movimiento visible con los filtros ya puestos,
// queda deshabilitado (más apagado, sin hover) hasta que esos otros filtros
// cambien lo suficiente como para que sí haya alguno.
function actualizarEstadoBotonPosIgual() {
    const btn = document.getElementById('pos-igual-btn');
    if (!btn) return;
    btn.disabled = !filtroPosIgual && !puedeActivarPosIgual();
}

document.getElementById('pos-igual-btn').onclick = (e) => {
    e.stopPropagation();
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filtroPosIgual = !filtroPosIgual;
    localStorage.setItem('filtroPosIgual', filtroPosIgual ? '1' : '0');
    // Si se activa y Posición Inicial/Final ya tenían valores explícitos
    // distintos entre sí, no quedaría ninguna toma para mostrar: se iguala
    // la Final a la Inicial para que la activación nunca deje la lista vacía.
    if (filtroPosIgual && filterPosIni !== filterPosFin) filterPosFin = filterPosIni;
    document.getElementById('pos-igual-btn').classList.toggle('active', filtroPosIgual);
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
document.getElementById('ver-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'dificultad';
    if (filterDificultad === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterDificultad = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
document.getElementById('posini-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'posIni';
    document.getElementById('posini-search').value = '';
    if (filterPosIni === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosIni = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};
document.getElementById('posfin-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'posFin';
    document.getElementById('posfin-search').value = '';
    if (filterPosFin === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosFin = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
};

// ===== AYUDA: VALOR ACTUAL "TAL COMO SE VE EN EL VIDEO" =====
// Devuelve el valor real de una dimensión (figura/posIni/posFin/dificultad)
// del combo que está mostrando el video en este momento, sin importar qué
// filtro esté (o no) seleccionado en los desplegables. Preserva "" (figuras/
// posiciones sin nombre propio, "---" en pantalla) tal cual, igual que hace
// activarComboCompleto; sólo devuelve null si todavía no hay combo cargado.
function valorActualDelVideo(dimension) {
    if (dimension === 'dificultad') {
        return (typeof currentDificultadValue === 'string') ? currentDificultadValue : null;
    }
    const combo = comboByKey[currentFigureValue] || {};
    if (dimension === 'figura') return (typeof combo.figura === 'string') ? combo.figura : null;
    if (dimension === 'posIni') return (typeof combo.posIni === 'string') ? combo.posIni : null;
    return (typeof combo.posFin === 'string') ? combo.posFin : null;
}

// ===== FIJAR/QUITAR FILTRO DESDE EL VIDEO (carteles centrales clickeables) =====
// Al clickear el cartel de Dificultad/Posición Inicial/Figura/Posición Final
// dentro del video:
// - Si esa dimensión NO tiene filtro activo (sin borde blanco interior), se
//   fija como filtro usando el valor que realmente se está viendo ahora (no
//   el que estuviera elegido en el menú).
// - Si esa dimensión YA tiene filtro activo (con borde blanco interior), se
//   quita ese filtro (vuelve a "Cualquiera"), igual que el botón ↺ del menú.
function filtroActivoEnDimension(dimension) {
    if (dimension === 'figura') return filterFigura !== null;
    if (dimension === 'dificultad') return filterDificultad !== null;
    if (dimension === 'posIni') return filterPosIni !== null;
    return filterPosFin !== null;
}

function fijarFiltroDesdeVideoActual(dimension) {
    const yaActivo = filtroActivoEnDimension(dimension);
    let nuevoValor;
    if (yaActivo) {
        nuevoValor = null;
    } else {
        nuevoValor = valorActualDelVideo(dimension);
        if (nuevoValor === null) return;
    }
    if (isPlaying || !isFirstAction) mutearParaCarga();
    ultimaDimensionSeleccionada = dimension;
    if (dimension === 'figura') filterFigura = nuevoValor;
    else if (dimension === 'dificultad') filterDificultad = nuevoValor;
    else if (dimension === 'posIni') filterPosIni = nuevoValor;
    else filterPosFin = nuevoValor;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
}

// ===== CÍRCULOS DE FIGURA (dentro del video) =====
// A diferencia del cartel de texto de Figura (que fija/quita la figura
// COMPLETA con fijarFiltroDesdeVideoActual), estos círculos fijan/quitan el
// filtro de Figura con un componente puntual: si la figura actual es
// singular hay un solo círculo (la figura entera); si es compuesta ("A +
// B") hay un círculo por cada parte, y cada uno filtra por esa parte sola.
// Clickear el círculo de una parte ya fijada la quita (vuelve a
// "Cualquiera"); clickear otro círculo cambia el filtro a esa otra parte.
function fijarFiltroFiguraComponente(valor) {
    const nuevoValor = (filterFigura === valor) ? null : valor;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    ultimaDimensionSeleccionada = 'figura';
    filterFigura = nuevoValor;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
}

// ===== BOTONES ENCADENAR POSICIÓN (dentro del video) =====
// Botón izquierdo (círculo celeste): la Posición Final que se ve AHORA en el
// video pasa a ser la nueva Posición Inicial, y la Posición Final se resetea
// a "Cualquiera". Botón derecho (círculo azul): al revés, la Posición
// Inicial que se ve ahora pasa a ser la nueva Posición Final, y la Posición
// Inicial se resetea. Usan el valor real del video actual (no el filtro
// elegido en el menú, que puede ser "Cualquiera"). Sirve para encadenar:
// terminaste en una posición y la usás como punto de partida del próximo
// movimiento (o viceversa), sin tener que ir a buscarla de nuevo en los
// desplegables.
document.getElementById('posini-swap-btn').onclick = (e) => {
    if (combosData.length === 0) return;
    if (e.currentTarget.disabled) return;
    const nuevaPosIni = valorActualDelVideo('posFin');
    if (nuevaPosIni === null || nuevaPosIni === '') return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosIni = nuevaPosIni;
    filterPosFin = null;
    ultimaDimensionSeleccionada = 'posIni';
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
};

document.getElementById('posfin-swap-btn').onclick = (e) => {
    if (combosData.length === 0) return;
    if (e.currentTarget.disabled) return;
    const nuevaPosFin = valorActualDelVideo('posIni');
    if (nuevaPosFin === null || nuevaPosFin === '') return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosFin = nuevaPosFin;
    filterPosIni = null;
    ultimaDimensionSeleccionada = 'posFin';
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
};

// ===== ¿SE PUEDE ENCADENAR LA POSICIÓN? (botones de encadenar, arriba) =====
// Un botón de encadenar Posición sólo tiene sentido si:
// 1) El video actual realmente tiene, en el lado que se va a copiar, una
//    Posición con nombre propio (si es "" -no tiene nombre propio, "---"-
//    no hay nada que encadenar), y
// 2) Aplicando ese encadenamiento (fijar esa Posición del lado destino y
//    resetear la del otro lado, dejando Figura y Dificultad como están)
//    todavía queda al menos un Movimiento visible — si no, sería encadenar
//    hacia un callejón sin salida por culpa de otro filtro ya activo
//    (Figura y/o Dificultad).
// dimensionDestino: 'posIni' (para posini-swap-btn) o 'posFin' (para
// posfin-swap-btn).
function swapEncadenarDisponible(dimensionDestino) {
    const dimensionOrigen = dimensionDestino === 'posIni' ? 'posFin' : 'posIni';
    const valor = valorActualDelVideo(dimensionOrigen);
    if (valor === null || valor === '') return false; // no hay Posición (con nombre) para encadenar
    const prevPosIni = filterPosIni;
    const prevPosFin = filterPosFin;
    if (dimensionDestino === 'posIni') {
        filterPosIni = valor;
        filterPosFin = null;
    } else {
        filterPosFin = valor;
        filterPosIni = null;
    }
    const disponible = combosFiltrados(null).length > 0;
    filterPosIni = prevPosIni;
    filterPosFin = prevPosFin;
    return disponible;
}

// ===== BUSCADOR DE MOVIMIENTOS POR CÓDIGO (🔍, hotkey B) =====
// Junta TODOS los Movimientos existentes (combinación + dificultad +
// variante), sin importar los filtros activos, cada uno con el código de su
// archivo de video (mismo "número + 3 letras" que ya usa el cartel opcional
// del toggle "T", ver extraerInfoArchivo), para poder ir directo a
// cualquiera tecleando su código.
function listaMovimientosConCodigo() {
    const lista = [];
    combosData.forEach(combo => {
        const dificultades = combo.dificultades || {};
        Object.keys(dificultades)
            .sort((a, b) => parseInt(a.replace('D', '')) - parseInt(b.replace('D', '')))
            .forEach(dif => {
                (dificultades[dif] || []).forEach((toma, variantIndex) => {
                    const info = extraerInfoArchivo(toma.file8t);
                    if (!info) return;
                    lista.push({
                        comboId: combo.id,
                        dificultad: dif,
                        variantIndex,
                        numero: info.numero,
                        letras: info.letras,
                        posIni: combo.posIni,
                        figura: combo.figura,
                        posFin: combo.posFin,
                    });
                });
            });
    });
    lista.sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true }));
    return lista;
}

// Búsqueda del 🔍 de Movimiento (L): además del código de 3 letras / número
// de archivo (como antes), ahora también busca por texto libre (sin
// importar tildes/mayúsculas, estilo __Reordenador.py) en Dificultad,
// Posición Inicial, Figura y Posición Final combinados, sin necesidad de
// que el texto tipeado coincida con ningún valor preconfigurado de esos
// desplegables. Igual que en la búsqueda de Figura / Posición Inicial /
// Posición Final, se puede escribir más de una palabra (varios movimientos
// a la vez) separadas por espacios: alcanza con que TODAS aparezcan en
// cualquier parte de esos campos combinados, sin importar el orden (ver
// contieneTodasLasPalabras), para poder buscar por ejemplo "gancho
// traslado" y encontrar tanto "Gancho + Traslado" como "Traslado + Gancho".
//
// Además, arriba de la lista de Movimientos puntuales, si hay texto tipeado
// se agrega el mismo ítem "🔎 Todas las que contengan..." que ya tienen
// Figura / Posición Inicial / Posición Final (ver htmlItemTextoLibre):
// tocarlo aplica ese texto como filtro PROPIO de la Lupa (ver
// filterMovSearchTexto / aplicarFiltroTextoLibreMovSearch) y CARGA en la
// navegación normal (grilla, paginación, etc.) TODOS los Movimientos que lo
// cumplan, en vez de tener que ir clickeando de a uno — sin tocar el filtro
// de Figura ni su desplegable. Esto no depende de la tecla Enter (que en
// varios teclados virtuales de celular no llega a dispararse), por eso
// convivía sólo el atajo de teclado con la lista puntual: ahora hay una
// forma tocable, igual que en los otros 3 buscadores.
function renderMovSearchList(query) {
    const listEl = document.getElementById('movsearch-list');
    if (!listEl) return;
    const qRaw = (query || '').trim();
    const qCodigo = qRaw.toUpperCase();
    const todos = listaMovimientosConCodigo();
    const etiquetaPosMov = (p) => (p === '' ? '---' : p);
    const filtrados = qRaw === '' ? todos : todos.filter(m => {
        if (m.letras.includes(qCodigo) || m.numero.includes(qCodigo)) return true;
        const textoCombinado = `${m.dificultad} ${m.posIni} ${m.figura} ${m.posFin}`;
        return contieneTodasLasPalabras(textoCombinado, qRaw);
    });
    let html = '';
    if (qRaw !== '') {
        const candidatosMovSearch = combosFiltrados('movsearch');
        const cantidadMovSearch = candidatosMovSearch.filter(c => contieneTodasLasPalabras(textoCombinadoDeCombo(c), qRaw)).length;
        html += htmlItemTextoLibre(qRaw, cantidadMovSearch, filterMovSearchTexto);
    }
    html += filtrados.length
        ? filtrados.map(m => `
            <div class="dropdown-item movsearch-item" data-combo="${m.comboId}" data-dif="${m.dificultad}" data-variant="${m.variantIndex}">
                <div class="movsearch-item-code"><span class="movsearch-item-numero">${m.numero}</span> - <span class="movsearch-item-letras">${m.letras}</span> <span class="movsearch-item-dif">[${m.dificultad}]</span></div>
                <div class="movsearch-item-desc"><span class="movsearch-item-posini">${etiquetaPosMov(m.posIni)}</span> → <span class="movsearch-item-figura">${m.figura}</span> → <span class="movsearch-item-posfin">${etiquetaPosMov(m.posFin)}</span></div>
            </div>`).join('')
        : `<div class="dropdown-item" style="cursor:default;opacity:0.6;">Sin resultados</div>`;
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item[data-textolibre]').forEach(item => {
        item.onclick = () => aplicarFiltroTextoLibreMovSearch(qRaw);
    });
    listEl.querySelectorAll('.dropdown-item[data-combo]').forEach(item => {
        item.onclick = () => {
            irAMovimientoPorCodigo(item.dataset.combo, item.dataset.dif, parseInt(item.dataset.variant, 10), false);
        };
    });
}

// Salta directo a un Movimiento puntual elegido por código.
// - fijarFiltros=true (comportamiento de siempre, usado por Favoritos): fija
//   Figura/Posición Inicial/Posición Final/Dificultad exactamente como los
//   tiene ese Movimiento (igual que activarComboCompleto), además de pararse
//   en la variante exacta (variantIndex) que corresponde a ese archivo
//   concreto. Así, navegar con ↑/↓ desde ahí se queda "enganchado" a esa
//   Figura/Posición.
// - fijarFiltros=false (usado por la Lupa, 🔍/L): NO toca esos 4 filtros ni
//   sus desplegables — sólo se para en esa Toma puntual (currentFigureValue/
//   currentDificultadValue/currentVariantIndex), dejando Figura/Dificultad/
//   Posición Inicial/Posición Final tal como estaban. Elegir un resultado de
//   la Lupa no debería "rellenar" esos menús con los valores de esa Toma.
function irAMovimientoPorCodigo(comboId, dificultad, variantIndex, fijarFiltros = true) {
    const combo = comboByKey[comboId];
    if (!combo) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    if (fijarFiltros) {
        activarComboCompleto(comboId);
        filterDificultad = dificultad;
    }
    currentFigureValue = comboId;
    currentDificultadValue = dificultad;
    currentVariantIndex = variantIndex;
    closeAllDropdowns();
    actualizarEtiquetasFiltros();
    actualizarEtiquetaDificultad();
    aplicarCambioVisual();
    // OJO: activarComboCompleto() ya disparó actualizarPaginacion() puertas
    // adentro (vía cargarDificultad()), pero con la Dificultad "automática"
    // calculada ahí, ANTES de que las líneas de arriba pisen
    // filterDificultad/currentDificultadValue/currentVariantIndex con los
    // valores exactos del favorito. Sin este segundo llamado, el contador
    // de arriba (1/1, 0/0, etc.) queda con el valor viejo aunque la grilla
    // ya se haya vuelto a pintar bien (por ejemplo, mostrando "No hay
    // Movimientos para mostrar" con el contador todavía en "1/1").
    actualizarPaginacion();
    registrarHistorialFiltros();
}

// El panel del buscador de Movimiento (🔍, L) es "position: fixed" y se
// ancla por su lado derecho al lado derecho del botón, exactamente igual que
// el panel de "Seleccionar lista de favoritos" (ver posicionarFavListPanel,
// más abajo en este archivo): así el panel siempre entra completo en la
// pantalla y se abre hacia la izquierda, sin importar dónde esté el botón en
// la fila (antes, con "left: 0" fijo en el CSS, se salía por el borde
// derecho cuando el botón quedaba cerca de ese borde).
function posicionarMovsearchPanel() {
    const panel = document.getElementById('movsearch-options-panel');
    const btn = document.getElementById('movsearch-btn');
    if (!panel || !btn) return;
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const rect = btn.getBoundingClientRect();
    const panelWidth = panel.getBoundingClientRect().width || panel.offsetWidth;
    let right = vw - rect.right;
    const maxRight = Math.max(0, vw - panelWidth);
    if (right > maxRight) right = maxRight;
    if (right < 0) right = 0;
    panel.style.right = `${right}px`;
    panel.style.top = `${rect.bottom + 6}px`;
}

document.getElementById('movsearch-btn').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('movsearch-options-panel', () => {
        // Mantiene lo que ya hubiera escrito de una apertura anterior (ver
        // closeAllDropdowns), en vez de arrancar siempre vacío.
        renderMovSearchList(document.getElementById('movsearch-search').value);
        posicionarMovsearchPanel();
        document.getElementById('movsearch-search').focus();
    });
};
document.getElementById('movsearch-options-panel').onclick = e => e.stopPropagation();
document.getElementById('movsearch-search').addEventListener('input', (e) => {
    renderMovSearchList(e.target.value);
});

// ===== FAVORITOS (varias listas con nombre) =====
// Cada lista es {id, name, items:[{comboId, dificultad, variantIndex}, ...]},
// todo guardado junto en UNA cookie (JSON), más otra cookie chica con el id
// de la lista "seleccionada" en el menú (a la que apunta el botón ⭐ suelto).
let favActiveListId = getCookie('favActiveListId') || null;

// Ids de listas mostradas expandidas (con sus Figuras visibles debajo).
// Independiente de cuál es la lista "activa" (destino del botón ⭐ suelto):
// una lista puede estar activa y colapsada, o expandida sin ser la activa.
// La lista activa arranca siempre expandida por defecto al abrir la app.
let favExpandedListIds = new Set(favActiveListId ? [favActiveListId] : []);

function getFavLists() {
    const raw = getCookie('favLists');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}
function guardarFavLists(lists) {
    setCookie('favLists', JSON.stringify(lists));
}
function setFavActiveListId(id) {
    favActiveListId = id;
    setCookie('favActiveListId', id || '');
    if (id) favExpandedListIds.add(id);
}
function generarFavListId() {
    return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Nombre sugerido para una lista nueva: "Mi Lista X", empezando en 1. Si ya
// existe una lista con ese nombre (por ejemplo "Mi Lista 1" sigue existiendo)
// prueba con el siguiente número, así nunca sugiere un nombre duplicado.
function siguienteNombreListaDisponible() {
    const nombresUsados = new Set(getFavLists().map(l => l.name));
    let n = 1;
    while (nombresUsados.has(`Mi Lista ${n}`)) n++;
    return `Mi Lista ${n}`;
}

// ¿Ya existe una lista (activa o no) con ese nombre? Compara sin
// mayúsculas/minúsculas y sin espacios sobrantes en las puntas, para no
// permitir "Mi Lista" y "mi lista " como si fueran nombres distintos.
// idAExcluir sirve para el caso de renombrar una lista contra sí misma.
function nombreListaYaExiste(nombre, idAExcluir) {
    const nombreNorm = nombre.trim().toLowerCase();
    return getFavLists().some(l => l.id !== idAExcluir && l.name.trim().toLowerCase() === nombreNorm);
}

// ¿Este item (comboId+dificultad+variantIndex/letras) ya está guardado en
// esta lista? Mismo criterio de comparación que usa el resto de la app
// (favoritos/ocultos): por código de 3 letras cuando ambos lo tienen, si no
// por variantIndex crudo.
function itemYaEnLista(lista, item) {
    return lista.items.some(it => {
        if (it.comboId !== item.comboId || it.dificultad !== item.dificultad) return false;
        if (it.letras && item.letras) return it.letras === item.letras;
        return it.variantIndex === item.variantIndex;
    });
}

function crearListaFavoritos(nombre) {
    const lists = getFavLists();
    const nueva = { id: generarFavListId(), name: nombre, items: [] };
    lists.push(nueva);
    guardarFavLists(lists);
    setFavActiveListId(nueva.id);
    return nueva;
}

// Elimina una lista de favoritos por id (esté vacía o no, sea o no la
// activa), pide confirmación, y si la borrada era la activa pasa a ser
// activa la primera que quede (o ninguna si no queda ninguna). La usan
// tanto el 🗑 de la fila de arriba (siempre sobre la lista activa) como la
// "✕" de cada fila individual (sobre la lista que se haya tocado).
function eliminarListaFavoritos(listId) {
    const lists = getFavLists();
    const lista = lists.find(l => l.id === listId);
    if (!lista) return;
    if (!confirm(`¿Eliminar la lista "${lista.name}" y sus ${lista.items.length} Figuras guardadas?`)) return;
    const restantes = lists.filter(l => l.id !== listId);
    favExpandedListIds.delete(listId);
    guardarFavLists(restantes);
    if (favActiveListId === listId) {
        setFavActiveListId(restantes.length ? restantes[0].id : null);
    }
    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    renderFavListDropdown();
}

// Dentro de las tomas actuales de una Dificultad, busca el índice cuyo
// código de 3 letras (ver extraerInfoArchivo) coincide con el buscado.
// Null si ninguna toma actual tiene ese código.
function indiceTomaPorLetras(tomas, letras) {
    if (!letras) return null;
    const idx = tomas.findIndex(t => {
        const info = extraerInfoArchivo(t.file8t);
        return info && info.letras === letras;
    });
    return idx === -1 ? null : idx;
}

// Resuelve la toma ACTUAL de una Figura guardada en una lista de favoritos.
// El nombre del archivo de video puede cambiar (por ejemplo el número, si se
// reordenan o agregan tomas nuevas), pero el código de 3 letras del final es
// siempre el identificador real y estable de ESA toma puntual. Por eso, si
// el favorito ya tiene "letras" guardado, se lo usa como fuente de verdad
// para encontrar la toma correcta hoy, en vez de confiar en el variantIndex
// crudo (que puede haber quedado apuntando a otra toma distinta tras un
// cambio así). Los favoritos guardados antes de este cambio (todavía sin
// "letras") se siguen resolviendo por variantIndex tal cual, como antes.
// Devuelve {variantIndex, toma} o null si esa Figura ya no tiene ninguna
// toma disponible en esa Dificultad.
function resolverTomaFavorito(item) {
    const combo = comboByKey[item.comboId];
    if (!combo) return null;
    const tomas = (combo.dificultades && combo.dificultades[item.dificultad]) || [];
    if (tomas.length === 0) return null;
    if (item.letras) {
        const idx = indiceTomaPorLetras(tomas, item.letras);
        return idx === null ? null : { variantIndex: idx, toma: tomas[idx] };
    }
    const toma = tomas[item.variantIndex] || null;
    return toma ? { variantIndex: item.variantIndex, toma } : null;
}

// Etiqueta legible de una Figura guardada, con el orden fijo pedido:
// "DX - Posición Inicial - Figura - Posición Final - Identificador de 3 letras".
// Datos crudos de una Figura guardada, compartidos por la versión de texto
// plano (usada en el title="" para el tooltip) y la versión coloreada
// (usada en la pantalla).
function datosEtiquetaFav(item) {
    const combo = comboByKey[item.comboId];
    if (!combo) return null;
    const fig = combo.figura === '' ? '---' : combo.figura;
    const ini = combo.posIni === '' ? '---' : combo.posIni;
    const fin = combo.posFin === '' ? '---' : combo.posFin;
    const resuelto = resolverTomaFavorito(item);
    const info = resuelto ? extraerInfoArchivo(resuelto.toma.file8t) : null;
    return { dif: item.dificultad, ini, fig, fin, letras: info ? info.letras : '---', numero: info ? info.numero : '' };
}

// Versión en texto plano (sin HTML), para el atributo title="" del tooltip.
function etiquetaMovimientoFav(item) {
    const d = datosEtiquetaFav(item);
    if (!d) return '(Movimiento ya no disponible)';
    const numTxt = d.numero ? ` - ${d.numero}` : '';
    return `${d.dif} - ${d.ini} - ${d.fig} - ${d.fin} - ${d.letras}${numTxt}`;
}

// Versión coloreada (Dificultad violeta, Posición Inicial celeste, Posición
// Final azul, Figura verde, código de letras naranja, código numérico
// gris), para mostrar en pantalla dentro de la lista.
function etiquetaMovimientoFavHTML(item) {
    const d = datosEtiquetaFav(item);
    if (!d) return '(Movimiento ya no disponible)';
    const numHtml = d.numero ? ` - <span class="fav-item-num">${d.numero}</span>` : '';
    return `<span class="fav-item-dif">${d.dif}</span> - <span class="fav-item-posini">${d.ini}</span> - <span class="fav-item-figura">${d.fig}</span> - <span class="fav-item-posfin">${d.fin}</span> - <span class="fav-item-letras">${d.letras}</span>${numHtml}`;
}

// Mueve una Figura dentro de su lista de favoritos, de fromIdx a toIdx
// (usado tanto por el arrastre como por las flechitas ▲/▼).
function moverItemFavLista(listId, fromIdx, toIdx) {
    const lists = getFavLists();
    const lista = lists.find(l => l.id === listId);
    if (!lista) return;
    if (toIdx < 0 || toIdx >= lista.items.length || fromIdx === toIdx) return;
    const [item] = lista.items.splice(fromIdx, 1);
    lista.items.splice(toIdx, 0, item);
    guardarFavLists(lists);
    renderFavListDropdown();
}

// Mueve una lista entera dentro del orden general de listas, de fromIdx a
// toIdx (mismo mecanismo que moverItemFavLista, pero sobre el array de listas).
function moverListaFav(fromIdx, toIdx) {
    const lists = getFavLists();
    if (toIdx < 0 || toIdx >= lists.length || fromIdx === toIdx) return;
    const [lista] = lists.splice(fromIdx, 1);
    lists.splice(toIdx, 0, lista);
    guardarFavLists(lists);
    renderFavListDropdown();
}

// Estado del arrastre en curso: de Figuras dentro de una lista, y de listas
// enteras entre sí (son dos arrastres distintos, nunca simultáneos).
let favDragState = null;
let favListDragState = null;

// Código de 3 letras (identificador estable, ver extraerInfoArchivo) de la
// toma que se está mostrando ahora mismo, o null si no hay una toma válida.
function letrasDeVarianteActual() {
    const combo = comboByKey[currentFigureValue];
    if (!combo) return null;
    const tomas = (combo.dificultades && combo.dificultades[currentDificultadValue]) || [];
    const toma = tomas[currentVariantIndex];
    const info = toma ? extraerInfoArchivo(toma.file8t) : null;
    return info ? info.letras : null;
}

// ¿La Figura que se está viendo ahora mismo ya está guardada en la lista
// activa? Determina si el botón ⭐ suelto debe quedar deshabilitado. Se
// compara por código de 3 letras (identificador real y estable de la toma)
// cuando el favorito ya lo tiene guardado; si no (favoritos viejos todavía
// sin migrar), se cae al variantIndex crudo como antes.
function figuraActualYaEnListaActiva() {
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return false;
    const activa = getFavLists().find(l => l.id === favActiveListId);
    if (!activa) return false;
    const letrasActual = letrasDeVarianteActual();
    return activa.items.some(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    });
}
// ¿La Figura que se está viendo ahora mismo ya está guardada en CUALQUIER
// lista de favoritos (esté o no seleccionada como la activa)? A diferencia
// de figuraActualYaEnListaActiva (que sólo mira la lista activa, para saber
// si el ⭐ agrega o quita), esto es sólo informativo: se usa para el
// puntito blanco que marca el ⭐ cuando la Figura ya está guardada en
// alguna parte.
function figuraActualEnAlgunaLista() {
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return false;
    const letrasActual = letrasDeVarianteActual();
    return getFavLists().some(l => l.items.some(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    }));
}
function actualizarEstadoBotonFavAdd() {
    const btn = document.getElementById('fav-add-current-btn');
    if (!btn) return;
    // Ya no se deshabilita cuando está guardada: ahora un click sobre el
    // ⭐ ya guardado la QUITA de la lista activa en vez de no hacer nada.
    // Se resalta (ver .fav-star-btn.active) para que quede claro que el
    // click ahora sería "quitar" en vez de "agregar".
    const yaGuardada = figuraActualYaEnListaActiva();
    btn.classList.toggle('active', yaGuardada);
    btn.classList.toggle('in-list', figuraActualEnAlgunaLista());
    btn.title = yaGuardada
        ? 'Quitar la Figura actual de la lista seleccionada'
        : 'Agregar la Figura actual a la lista seleccionada';
}

// Botón 💾 (guardar los Movimientos del filtro actual en una lista):
// deshabilitado cuando no hay ningún filtro activo (Figura, Posición
// Inicial, Posición Final ni Dificultad), porque en ese caso "el filtro
// actual" serían TODOS los Movimientos de la app — mismo chequeo que usa
// resetearTodosLosFiltros para saber si hay algo para resetear.
function actualizarEstadoBotonFavSaveFiltered() {
    const btn = document.getElementById('fav-list-save-filtered-btn');
    if (!btn) return;
    const hayFiltroActivo = !(filterFigura === null && filterDificultad === null && filterPosIni === null && filterPosFin === null && filterMovSearchTexto === null);
    btn.disabled = !hayFiltroActivo;
}

// Refresca el texto mostrado del menú ("..." por defecto, para que el menú
// quepa en su ancho acotado de 85px, o el nombre + cantidad de la lista
// elegida), igual patrón que el resto de los desplegables
// (fig/posini/posfin/song). También marca el contenedor con la clase
// "has-lists" cuando ya existe alguna lista creada, para que el CSS le dé
// más ancho al botón (ver #fav-list-dropdown-container.has-lists) que
// cuando todavía no hay ninguna.
function actualizarEtiquetaFavLista() {
    const lists = getFavLists();
    const activa = lists.find(l => l.id === favActiveListId);
    setDropdownSelectedHTML('fav-list-selected', activa
        ? `📋 ${activa.name} - [${activa.items.length}]`
        : '...');
    const contenedor = document.getElementById('fav-list-dropdown-container');
    if (contenedor) contenedor.classList.toggle('has-lists', lists.length > 0);
}

// Panel del menú: arriba la fila +/✎/🗑 (actúan sobre la lista elegida),
// abajo TODAS las listas (reordenables por arrastre o con ▲/▼, y borrables
// directamente con su propia "✕", esté vacía o no); cada una se puede
// expandir/colapsar con el triángulo ▸/▾ para ver, debajo, sus Figuras
// guardadas (a su vez reordenables), saltar directo a una o quitarla con
// su propia "✕".
// Completa in-place el código de 3 letras de cualquier Figura guardada que
// todavía no lo tenga (favoritos guardados antes de que existiera este
// campo), resolviéndolo por su variantIndex actual, y persiste el cambio si
// hizo falta. La usan tanto el render del menú de Favoritos como la
// exportación (que a partir de ahora sólo guarda ese código, nunca
// comboId/Dificultad/variantIndex crudos, porque esos sí pueden cambiar).
function migrarLetrasFavLists(lists) {
    let huboMigracion = false;
    lists.forEach(l => {
        l.items.forEach(it => {
            if (it.letras) return;
            const resuelto = resolverTomaFavorito(it);
            const info = resuelto ? extraerInfoArchivo(resuelto.toma.file8t) : null;
            if (info) {
                it.letras = info.letras;
                huboMigracion = true;
            }
        });
    });
    if (huboMigracion) guardarFavLists(lists);
    return lists;
}

function renderFavListDropdown() {
    const listEl = document.getElementById('fav-list-list');
    const lists = getFavLists();
    if (lists.length === 0) {
        listEl.innerHTML = '<div class="dropdown-item" style="cursor:default;opacity:0.6;">Sin listas todavía — creá una con "+"</div>';
        return;
    }
    // Migración silenciosa: a las Figuras guardadas ANTES de este cambio (sin
    // "letras" todavía) se les completa el código de 3 letras la primera vez
    // que se puede resolver por su variantIndex actual, y se persiste, para
    // que de ahí en más queden identificadas por ese código estable en vez
    // del variantIndex crudo (ver resolverTomaFavorito).
    migrarLetrasFavLists(lists);
    if (!lists.some(l => l.id === favActiveListId)) {
        setFavActiveListId(lists[0].id);
        actualizarEtiquetaFavLista();
    }
    listEl.innerHTML = lists.map((l, listIdx) => {
        const activa = l.id === favActiveListId;
        const expandida = favExpandedListIds.has(l.id);
        const subitems = !expandida ? '' : (l.items.length === 0
            ? '<div class="fav-sub-empty">Esta lista todavía no tiene Figuras guardadas</div>'
            : l.items.map((item, idx) => `
                <div class="fav-sub-item" draggable="true" data-list="${l.id}" data-idx="${idx}">
                    <span class="fav-item-drag-handle" title="Arrastrar para reordenar">⠿</span>
                    <span class="fav-item-label" title="${etiquetaMovimientoFav(item)}">${etiquetaMovimientoFavHTML(item)}</span>
                    <span class="fav-item-move ${idx === 0 ? 'fav-item-move-disabled' : ''}" data-action="up" data-list="${l.id}" data-idx="${idx}" title="Subir un lugar">▲</span>
                    <span class="fav-item-move ${idx === l.items.length - 1 ? 'fav-item-move-disabled' : ''}" data-action="down" data-list="${l.id}" data-idx="${idx}" title="Bajar un lugar">▼</span>
                    <span class="fav-item-remove" data-list="${l.id}" data-idx="${idx}" title="Quitar de la lista">✕</span>
                </div>
            `).join(''));
        return `
            <div class="dropdown-item fav-list-item ${activa ? 'selected' : ''}" draggable="true" data-id="${l.id}" data-idx="${listIdx}">
                <span class="fav-list-drag-handle" title="Arrastrar para reordenar la lista">⠿</span>
                <span class="fav-list-expand-toggle" data-id="${l.id}" title="Expandir/Colapsar">${expandida ? '▾' : '▸'}</span>
                <span class="fav-list-name-label" data-id="${l.id}">📋 ${l.name} - [${l.items.length}]</span>
                <span class="fav-list-move ${listIdx === 0 ? 'fav-item-move-disabled' : ''}" data-action="up" data-idx="${listIdx}" title="Subir lista">▲</span>
                <span class="fav-list-move ${listIdx === lists.length - 1 ? 'fav-item-move-disabled' : ''}" data-action="down" data-idx="${listIdx}" title="Bajar lista">▼</span>
                <span class="fav-list-remove" data-id="${l.id}" title="Eliminar esta lista">✕</span>
            </div>
            ${subitems}
        `;
    }).join('');

    listEl.querySelectorAll('.fav-list-name-label').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            setFavActiveListId(el.dataset.id);
            actualizarEtiquetaFavLista();
            actualizarEstadoBotonFavAdd();
            renderFavListDropdown();
        };
    });
    listEl.querySelectorAll('.fav-list-expand-toggle').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            if (favExpandedListIds.has(el.dataset.id)) {
                favExpandedListIds.delete(el.dataset.id);
            } else {
                favExpandedListIds.add(el.dataset.id);
            }
            renderFavListDropdown();
        };
    });
    listEl.querySelectorAll('.fav-list-item').forEach(el => {
        // Arrastrar y soltar para reordenar las listas entre sí.
        el.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            favListDragState = parseInt(el.dataset.idx, 10);
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            favListDragState = null;
        });
        el.addEventListener('dragover', (e) => {
            if (favListDragState === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        el.addEventListener('drop', (e) => {
            if (favListDragState === null) return;
            e.preventDefault();
            e.stopPropagation();
            moverListaFav(favListDragState, parseInt(el.dataset.idx, 10));
        });
    });
    listEl.querySelectorAll('.fav-list-move').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            if (el.classList.contains('fav-item-move-disabled')) return;
            const idx = parseInt(el.dataset.idx, 10);
            const delta = el.dataset.action === 'up' ? -1 : 1;
            moverListaFav(idx, idx + delta);
        };
    });
    listEl.querySelectorAll('.fav-list-remove').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            eliminarListaFavoritos(el.dataset.id);
        };
    });
    listEl.querySelectorAll('.fav-sub-item').forEach(el => {
        el.onclick = () => {
            const lista = getFavLists().find(l => l.id === el.dataset.list);
            const item = lista && lista.items[parseInt(el.dataset.idx, 10)];
            if (!item || !comboByKey[item.comboId]) return;
            const resuelto = resolverTomaFavorito(item);
            if (!resuelto) return;
            closeAllDropdowns();
            irAMovimientoPorCodigo(item.comboId, item.dificultad, resuelto.variantIndex);
        };
        // Arrastrar y soltar para reordenar dentro de la misma lista.
        el.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            favDragState = { listId: el.dataset.list, fromIdx: parseInt(el.dataset.idx, 10) };
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            favDragState = null;
        });
        el.addEventListener('dragover', (e) => {
            if (!favDragState || favDragState.listId !== el.dataset.list) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        el.addEventListener('drop', (e) => {
            if (!favDragState || favDragState.listId !== el.dataset.list) return;
            e.preventDefault();
            e.stopPropagation();
            const toIdx = parseInt(el.dataset.idx, 10);
            moverItemFavLista(favDragState.listId, favDragState.fromIdx, toIdx);
        });
    });
    listEl.querySelectorAll('.fav-item-move').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            if (el.classList.contains('fav-item-move-disabled')) return;
            const idx = parseInt(el.dataset.idx, 10);
            const delta = el.dataset.action === 'up' ? -1 : 1;
            moverItemFavLista(el.dataset.list, idx, idx + delta);
        };
    });
    listEl.querySelectorAll('.fav-item-remove').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            const lists2 = getFavLists();
            const lista = lists2.find(l => l.id === el.dataset.list);
            if (!lista) return;
            lista.items.splice(parseInt(el.dataset.idx, 10), 1);
            guardarFavLists(lists2);
            actualizarEtiquetaFavLista();
            actualizarEstadoBotonFavAdd();
            renderFavListDropdown();
        };
    });
}

// El panel de "Seleccionar lista" (📋) es "position: fixed" y se ancla por
// su lado derecho al lado derecho del botón (ver CSS #fav-list-options-panel),
// igual que el desplegable de Posición Final: se abre hacia la izquierda en
// vez de centrarse en la pantalla. Se calculan ambas coordenadas con
// getBoundingClientRect() (viewport), ya que "fixed" se posiciona relativo
// a la pantalla, no al botón. Si el botón está muy cerca del borde
// izquierdo (pantallas angostas), anclarlo estrictamente a su lado derecho
// haría que el panel se corra fuera de la pantalla por la izquierda — por
// eso el resultado se acota (clamp) para que el panel siempre quede
// completo dentro del ancho visible.
function posicionarFavListPanel() {
    const panel = document.getElementById('fav-list-options-panel');
    const btn = document.getElementById('fav-list-selected');
    if (!panel || !btn) return;
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const rect = btn.getBoundingClientRect();
    const panelWidth = panel.getBoundingClientRect().width || panel.offsetWidth;
    let right = vw - rect.right;
    const maxRight = Math.max(0, vw - panelWidth);
    if (right > maxRight) right = maxRight;
    if (right < 0) right = 0;
    panel.style.right = `${right}px`;
    panel.style.top = `${rect.bottom + 4}px`;
}

document.getElementById('fav-list-selected').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('fav-list-options-panel', () => {
        renderFavListDropdown();
        posicionarFavListPanel();
    });
};
document.getElementById('fav-list-options-panel').onclick = e => e.stopPropagation();

document.getElementById('fav-list-new-btn').onclick = (e) => {
    e.stopPropagation();
    let nombre = prompt('Nombre de la nueva lista de favoritos:', siguienteNombreListaDisponible());
    while (nombre !== null && nombre.trim() && nombreListaYaExiste(nombre, null)) {
        nombre = prompt(`Ya existe una lista llamada "${nombre.trim()}". Elegí otro nombre:`, '');
    }
    if (!nombre || !nombre.trim()) return;
    crearListaFavoritos(nombre.trim());
    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    renderFavListDropdown();
};

document.getElementById('fav-list-rename-btn').onclick = (e) => {
    e.stopPropagation();
    const lists = getFavLists();
    const activa = lists.find(l => l.id === favActiveListId);
    if (!activa) return;
    let nuevoNombre = prompt('Nuevo nombre para esta lista:', activa.name);
    while (nuevoNombre !== null && nuevoNombre.trim() && nombreListaYaExiste(nuevoNombre, activa.id)) {
        nuevoNombre = prompt(`Ya existe otra lista llamada "${nuevoNombre.trim()}". Elegí otro nombre:`, '');
    }
    if (!nuevoNombre || !nuevoNombre.trim()) return;
    activa.name = nuevoNombre.trim();
    guardarFavLists(lists);
    actualizarEtiquetaFavLista();
    renderFavListDropdown();
};

// Botón 💾: guarda TODOS los Movimientos que cumplen el filtro actualmente
// activo (Figura/Posición Inicial/Posición Final/
// Dificultad/"=", respetando también las Figuras ocultas, salvo que
// "Mostrar figuras ocultas" esté prendido — mismo criterio que
// construirPasosFiltrados, que es lo que arma el contador "X/Y" de arriba).
// Útil para guardar de un solo toque, por ejemplo, "todas las Figuras de
// D3" o "todas las que terminan en una Posición puntual".
// A diferencia de "+" (nueva lista) y "✎" (renombrar), acá SÍ se permite
// escribir el nombre de una lista ya existente a propósito: en vez de
// rechazarlo, se adhiere a esa lista tal cual (sin crear una nueva ni pedir
// otro nombre), agregando únicamente los Movimientos del filtro actual que
// todavía no estuvieran guardados ahí — nunca duplicando los que ya estaban.
document.getElementById('fav-list-save-filtered-btn').onclick = (e) => {
    e.stopPropagation();
    const pasos = construirPasosFiltrados();
    if (pasos.length === 0) {
        alert('No hay ningún Movimiento que cumpla el filtro actual para guardar.');
        return;
    }
    const nombre = prompt(`Nombre de la lista (se van a guardar los ${pasos.length} Movimientos que cumplen el filtro actual; si el nombre ya existe, se agregan a esa lista sin repetir los que ya estaban):`, siguienteNombreListaDisponible());
    if (!nombre || !nombre.trim()) return;
    const nombreTrim = nombre.trim();

    let lists = getFavLists();
    const existente = lists.find(l => l.name.trim().toLowerCase() === nombreTrim.toLowerCase());
    let listId;
    if (existente) {
        listId = existente.id;
        setFavActiveListId(listId);
    } else {
        listId = crearListaFavoritos(nombreTrim).id;
        lists = getFavLists();
    }
    const lista = lists.find(l => l.id === listId);
    if (lista) {
        pasos.forEach(p => {
            const combo = comboByKey[p.comboId];
            const toma = combo && combo.dificultades && combo.dificultades[p.dificultad] && combo.dificultades[p.dificultad][p.variantIndex];
            const info = toma ? extraerInfoArchivo(toma.file8t) : null;
            const item = { comboId: p.comboId, dificultad: p.dificultad, variantIndex: p.variantIndex, letras: info ? info.letras : undefined };
            if (!itemYaEnLista(lista, item)) lista.items.push(item);
        });
        guardarFavLists(lists);
    }
    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    renderFavListDropdown();
};

document.getElementById('fav-list-delete-btn').onclick = (e) => {
    e.stopPropagation();
    if (!favActiveListId) return;
    eliminarListaFavoritos(favActiveListId);
};

// Botón ⭐ suelto: NO despliega ningún panel. Agrega la Figura actual
// (Figura + Posición Inicial/Final + Dificultad + variante que se están
// mostrando en este momento) a la lista elegida en el menú de al lado, o
// la QUITA de esa misma lista si ya estaba guardada (ver
// actualizarEstadoBotonFavAdd para el resaltado que indica cuál de las dos
// cosas va a hacer el próximo click).
document.getElementById('fav-add-current-btn').onclick = (e) => {
    e.stopPropagation();
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return;
    let lists = getFavLists();
    let activa = lists.find(l => l.id === favActiveListId);
    if (!activa) {
        let nombre = prompt('No hay ninguna lista seleccionada. Nombre de la nueva lista de favoritos:', siguienteNombreListaDisponible());
        while (nombre !== null && nombre.trim() && nombreListaYaExiste(nombre, null)) {
            nombre = prompt(`Ya existe una lista llamada "${nombre.trim()}". Elegí otro nombre:`, '');
        }
        if (!nombre || !nombre.trim()) return;
        const nueva = crearListaFavoritos(nombre.trim());
        lists = getFavLists();
        activa = lists.find(l => l.id === nueva.id);
        actualizarEtiquetaFavLista();
    }
    const letrasActual = letrasDeVarianteActual();
    const idxExistente = activa.items.findIndex(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    });
    if (idxExistente !== -1) {
        activa.items.splice(idxExistente, 1);
    } else {
        activa.items.push({ comboId: currentFigureValue, dificultad: currentDificultadValue, variantIndex: currentVariantIndex, letras: letrasActual });
    }
    guardarFavLists(lists);
    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    renderFavListDropdown();
};

// ===== FIGURAS OCULTAS =====
// Lista simple (a diferencia de Favoritos, sin nombre ni múltiples listas)
// de tomas puntuales que el usuario decidió sacar de la navegación normal
// con el botón 🙈 (al lado del ⭐): [{comboId, dificultad, variantIndex,
// letras}, ...]. A diferencia de favLists (que vive en cookie), esta lista
// se guarda en localStorage: al no tener nombres ni estar dividida en
// varias listas, puede crecer bastante más que los Favoritos (un usuario
// activo termina ocultando decenas de tomas), y las cookies tienen un
// límite de tamaño de ~4KB por cookie — pasado ese límite el navegador
// directamente descarta el guardado sin avisar, lo cual se manifestaba
// como "dejar de poder ocultar" a partir de cierta cantidad. localStorage
// no tiene ese problema (~5-10MB de margen), y persiste igual entre
// sesiones.
function getHiddenSteps() {
    const raw = localStorage.getItem('hiddenSteps');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}
function guardarHiddenSteps(items) {
    localStorage.setItem('hiddenSteps', JSON.stringify(items));
}

// ===== NOTAS PERSONALES POR MOVIMIENTO =====
// Recordatorio de texto libre, opcional, por cada toma puntual: [{comboId,
// dificultad, variantIndex, letras, texto}, ...]. Vive en cookie (igual que
// favLists), porque son mensajes cortos y no debería haber demasiados.
function getNotas() {
    const raw = getCookie('notas');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}
function guardarNotas(items) {
    setCookie('notas', JSON.stringify(items));
}

// Busca, dentro de las notas guardadas, la que corresponde a la toma que se
// está viendo ahora mismo (mismo criterio de comparación que el resto:
// código de 3 letras primero, variantIndex como respaldo). Devuelve el
// índice dentro del array (o -1), para poder reusarlo tanto al leer como
// al editar/borrar.
function indiceNotaActual(notas) {
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return -1;
    const letrasActual = letrasDeVarianteActual();
    return notas.findIndex(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    });
}

// Refresca el look del botón 📝: resaltado cuando el movimiento actual ya
// tiene una nota guardada (y el tooltip muestra el texto guardado), mismo
// patrón que el resto de los botones sueltos (⭐/🙈). De paso, refresca
// también el cartelito blanco con el texto de la nota, pegado al borde
// inferior del video (ver actualizarNotaEnVideo).
function actualizarEstadoBotonNota() {
    const btn = document.getElementById('fig-note-btn');
    if (!btn) return;
    const notas = getNotas();
    const idx = indiceNotaActual(notas);
    const tieneNota = idx !== -1;
    btn.classList.toggle('active', tieneNota);
    btn.title = tieneNota
        ? `Nota: ${notas[idx].texto} (N)`
        : 'Anotar una nota para el movimiento actual (N)';
    actualizarNotaEnVideo(tieneNota ? notas[idx].texto : null);
}

// Muestra/oculta el cartelito blanco con el texto de la nota DENTRO del
// video actual, debajo de las flechas de Posición Inicial/Final (que suben
// un poco mientras el cartelito está visible, para no superponerse).
function actualizarNotaEnVideo(texto) {
    const el = document.getElementById('figure-note-display');
    const wrapper = document.getElementById('video-center-wrapper');
    if (!el || !wrapper) return;
    if (!texto) {
        el.classList.remove('visible');
        el.innerText = '';
        wrapper.classList.remove('has-note');
        return;
    }
    el.innerText = texto;
    el.classList.add('visible');
    wrapper.classList.add('has-note');
}

// Botón 📝 suelto (al lado del 🙈): abre un prompt para escribir/editar la
// nota de la toma actual. Dejarlo en blanco borra la nota existente.
document.getElementById('fig-note-btn').onclick = (e) => {
    e.stopPropagation();
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return;
    const notas = getNotas();
    const idxExistente = indiceNotaActual(notas);
    const actual = idxExistente !== -1 ? notas[idxExistente].texto : '';
    const texto = prompt('Nota personal para este movimiento (dejala vacía para borrarla):', actual);
    if (texto === null) return; // canceló, no toca nada
    if (texto.trim() === '') {
        if (idxExistente !== -1) notas.splice(idxExistente, 1);
    } else if (idxExistente !== -1) {
        notas[idxExistente].texto = texto;
    } else {
        notas.push({
            comboId: currentFigureValue,
            dificultad: currentDificultadValue,
            variantIndex: currentVariantIndex,
            letras: letrasDeVarianteActual(),
            texto,
        });
    }
    guardarNotas(notas);
    actualizarEstadoBotonNota();
};

// ¿La toma que se está viendo ahora mismo ya está en la lista de ocultas?
// Mismo criterio de comparación (código de 3 letras primero, variantIndex
// como respaldo) que figuraActualYaEnListaActiva.
function pasoActualEstaOculto() {
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return false;
    const letrasActual = letrasDeVarianteActual();
    return getHiddenSteps().some(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    });
}

// Refresca el look del botón 🙈: resaltado en rojo (y título distinto)
// cuando el movimiento actual ya está oculto, para que un segundo click
// se entienda como "restablecer" y no como "ocultar de nuevo".
// Refresca el look del botón 🙈: resaltado en rojo (y título distinto)
// cuando el movimiento actual ya está oculto, para que un segundo click
// se entienda como "restablecer" y no como "ocultar de nuevo". Si no hay
// NINGÚN Movimiento para mostrar (mismo caso que el aviso "No hay
// Movimientos para mostrar" de renderGrid), el botón directamente se
// deshabilita (grisado, igual que < > cuando no hay a dónde navegar): no
// tiene sentido ofrecer ocultar/mostrar algo que ni siquiera se está viendo.
function actualizarEstadoBotonHide() {
    const btn = document.getElementById('fig-hide-current-btn');
    if (!btn) return;
    if (construirPasosFiltrados().length === 0) {
        btn.disabled = true;
        btn.classList.remove('active');
        btn.title = 'No hay ningún Movimiento para ocultar/mostrar';
        return;
    }
    btn.disabled = false;
    const oculto = pasoActualEstaOculto();
    btn.classList.toggle('active', oculto);
    btn.title = oculto ? 'Mostrar de nuevo el movimiento actual (está oculto) (O)' : 'Ocultar el movimiento actual (O)';
}

// Botón 🙈 suelto (al lado del ⭐, mismo estilo de "un solo click, sin
// desplegar nada"): oculta la toma actual, o la restablece si ya estaba
// oculta. Como una toma oculta desaparece de inmediato de la navegación
// normal (ver construirPasosFiltrados), al ocultar hay que reubicarse en
// el movimiento que pase a ocupar ese mismo lugar (equivalente, en la
// práctica, a "avanzar al siguiente") — salvo que "Mostrar figuras
// ocultas" esté activo, en cuyo caso no desaparece nada y no hace falta
// moverse.
document.getElementById('fig-hide-current-btn').onclick = (e) => {
    e.stopPropagation();
    if (!currentFigureValue || !comboByKey[currentFigureValue]) return;

    const pasosAntes = !mostrarFigurasOcultas ? construirPasosFiltrados() : null;
    const idxAntes = pasosAntes ? indicePasoActual(pasosAntes) : -1;

    const hidden = getHiddenSteps();
    const letrasActual = letrasDeVarianteActual();
    const idxExistente = hidden.findIndex(it => {
        if (it.comboId !== currentFigureValue || it.dificultad !== currentDificultadValue) return false;
        if (it.letras && letrasActual) return it.letras === letrasActual;
        return it.variantIndex === currentVariantIndex;
    });

    let seAcabaDeOcultar = false;
    if (idxExistente !== -1) {
        hidden.splice(idxExistente, 1);
    } else {
        hidden.push({ comboId: currentFigureValue, dificultad: currentDificultadValue, variantIndex: currentVariantIndex, letras: letrasActual });
        seAcabaDeOcultar = true;
    }
    guardarHiddenSteps(hidden);

    if (seAcabaDeOcultar && !mostrarFigurasOcultas) {
        const pasosDespues = construirPasosFiltrados();
        if (pasosDespues.length > 0) {
            const nuevoIdx = Math.max(0, Math.min(idxAntes, pasosDespues.length - 1));
            const paso = pasosDespues[nuevoIdx];
            if (isPlaying || !isFirstAction) mutearParaCarga();
            currentFigureValue = paso.comboId;
            currentDificultadValue = paso.dificultad;
            currentVariantIndex = paso.variantIndex;
            actualizarEtiquetaDificultad();
        }
        // Importante: recalcular el contador de arriba SIEMPRE, incluso
        // cuando pasosDespues.length === 0 (se acaba de ocultar el último
        // Movimiento que quedaba visible). Si no, aplicarCambioVisual() de
        // abajo repinta bien la grilla con "No hay Movimientos para
        // mostrar", pero el contador queda pisado con el valor de antes de
        // ocultar (ej. "1/1" en vez de "0/0").
        actualizarPaginacion();
    }
    aplicarCambioVisual();
    actualizarEstadoBotonHide();
    actualizarEtiquetaFigurasOcultas();
};

document.getElementById('fig-options-panel').onclick = e => e.stopPropagation();
document.getElementById('song-options-panel').onclick = e => e.stopPropagation();
document.getElementById('ver-options-panel').onclick = e => e.stopPropagation();
document.addEventListener('click', closeAllDropdowns);

document.getElementById('fig-search').addEventListener('input', (e) => {
    renderFigureList(e.target.value);
});

document.getElementById('posini-search').addEventListener('input', (e) => {
    renderPosIniList(e.target.value);
});

document.getElementById('posfin-search').addEventListener('input', (e) => {
    renderPosFinList(e.target.value);
});

document.getElementById('song-search').addEventListener('input', (e) => {
    const sortActive = document.getElementById('sort-abc').classList.contains('active') ? 'abc' : 'bpm';
    renderSongList(e.target.value, sortActive);
});

// ===== NAVEGACION =====
// Devuelve los valores disponibles (ordenados) para una dimensión
// (figura/posIni/posFin/dificultad), respetando los OTROS filtros activos,
// igual que hacen los desplegables (combosFiltrados excluye sólo la
// dimensión propia).
function valoresDisponiblesDimension(dimension) {
    if (dimension === 'dificultad') return nivelesDificultadDisponibles();
    const candidatos = combosFiltrados(dimension);
    const campo = dimension; // 'figura' | 'posIni' | 'posFin'
    if (campo === 'figura') {
        // Igual que en renderFigureList: se incluye la figura completa y
        // también cada movimiento individual de las compuestas, para que
        // Q/E y las flechas puedan pasar por "Gancho" y "Traslado" sueltos.
        const valorSet = new Set();
        candidatos.forEach(c => {
            valorSet.add(c.figura);
            componentesDeFigura(c.figura).forEach(p => valorSet.add(p));
        });
        return [...valorSet]
            .sort((a, b) => (a === '' ? '---' : a).localeCompare(b === '' ? '---' : b));
    }
    // Posición Inicial / Final: se incluye también el valor "" ("---",
    // posiciones sin nombre propio), igual criterio que la Figura.
    const crudos = candidatos.map(c => c[campo]).filter(v => typeof v === 'string');
    return [...new Set(crudos)]
        .sort((a, b) => (a === '' ? '---' : a).localeCompare(b === '' ? '---' : b));
}

// Mueve con ↑ / ↓ (o Q / E) la dimensión (Figura, Posición Inicial,
// Posición Final o Dificultad) que el usuario haya tocado por última vez.
// Si todavía no tocó ninguna (recién cargada la página), mueve la Figura
// por defecto.
// Al retroceder (dirección -1) desde el primer valor de la lista, cae en
// "Cualquiera" en vez de quedarse trabado ahí.
function cambiarPorFlechas(direccion) {
    if (combosData.length === 0) return;
    const dimension = ultimaDimensionSeleccionada;
    const valores = valoresDisponiblesDimension(dimension);
    if (valores.length === 0) return;

    let filterActual;
    if (dimension === 'figura') filterActual = filterFigura;
    else if (dimension === 'posIni') filterActual = filterPosIni;
    else if (dimension === 'dificultad') filterActual = filterDificultad;
    else filterActual = filterPosFin;

    const currentIndex = filterActual !== null ? valores.indexOf(filterActual) : -1;

    let nuevoValor;
    if (direccion < 0) {
        if (currentIndex <= 0) {
            if (filterActual === null) return; // ya estaba en "Cualquiera"
            nuevoValor = null; // primer valor -> retroceder cae en "Cualquiera"
        } else {
            nuevoValor = valores[currentIndex - 1];
        }
    } else {
        const newIndex = currentIndex + 1;
        if (newIndex >= valores.length) return; // último valor, no avanza más
        nuevoValor = valores[newIndex];
    }

    if (dimension === 'figura') filterFigura = nuevoValor;
    else if (dimension === 'posIni') filterPosIni = nuevoValor;
    else if (dimension === 'dificultad') filterDificultad = nuevoValor;
    else filterPosFin = nuevoValor;

    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();

    // Si el desplegable correspondiente está abierto, refrescar su resaltado.
    if (dimension === 'figura') renderFigureList(document.getElementById('fig-search').value);
    else if (dimension === 'posIni') renderPosIniList(document.getElementById('posini-search').value);
    else if (dimension === 'dificultad') renderDificultadList();
    else renderPosFinList(document.getElementById('posfin-search').value);

    if (isFirstAction) forzarPrimeraCancionYReiniciar();
}

// Tecla W: pone en "Cualquiera" de una sola vez la dimensión que se haya
// tocado por última vez (Figura, Posición Inicial, Posición Final o
// Dificultad), sin tener que ir retrocediendo de a un valor.
function resetearDimensionActual() {
    if (combosData.length === 0) return;
    const dimension = ultimaDimensionSeleccionada;
    let filterActual;
    if (dimension === 'figura') filterActual = filterFigura;
    else if (dimension === 'posIni') filterActual = filterPosIni;
    else if (dimension === 'dificultad') filterActual = filterDificultad;
    else filterActual = filterPosFin;
    if (filterActual === null) return; // ya estaba en "Cualquiera"

    if (dimension === 'figura') filterFigura = null;
    else if (dimension === 'posIni') filterPosIni = null;
    else if (dimension === 'dificultad') filterDificultad = null;
    else filterPosFin = null;

    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();

    if (dimension === 'figura') renderFigureList(document.getElementById('fig-search').value);
    else if (dimension === 'posIni') renderPosIniList(document.getElementById('posini-search').value);
    else if (dimension === 'dificultad') renderDificultadList();
    else renderPosFinList(document.getElementById('posfin-search').value);
}

// Tecla F: pone TODOS los filtros (Figura, Dificultad, Posición Inicial y
// Posición Final) en "Cualquiera" de una sola vez, sin importar cuál haya
// sido la última dimensión tocada.
function resetearTodosLosFiltros() {
    if (combosData.length === 0) return;
    if (filterFigura === null && filterDificultad === null && filterPosIni === null && filterPosFin === null && filterMovSearchTexto === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();

    filterFigura = null;
    filterDificultad = null;
    filterPosIni = null;
    filterPosFin = null;
    filterMovSearchTexto = null;

    // 🌈/F resetea TODOS los filtros de una (incluida la búsqueda propia de
    // la Lupa): junto con eso, limpiar también lo que hubiera quedado
    // escrito en los buscadores de Figura/Posición/Movimiento (que ahora
    // persisten entre aperturas — ver closeAllDropdowns), para que arranquen
    // limpios la próxima vez que se abran.
    document.getElementById('fig-search').value = '';
    document.getElementById('posini-search').value = '';
    document.getElementById('posfin-search').value = '';
    document.getElementById('movsearch-search').value = '';

    recalcularComboActual();
    aplicarCambioVisual();
    registrarHistorialFiltros();

    // Si algún desplegable está abierto, refrescar su resaltado también.
    renderFigureList(document.getElementById('fig-search').value);
    renderDificultadList();
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
    renderMovSearchList(document.getElementById('movsearch-search').value);
}

// ===== HISTORIAL DE FILTROS (Deshacer / Rehacer, Ctrl+Z / Ctrl+Y) =====
// Cada vez que cambia alguno de los 4 filtros (Figura, Dificultad, Posición
// Inicial, Posición Final), por cualquier vía (desplegables, botones ↺,
// flechas ↑/↓ o Q/E, tecla F/W, atajos numéricos de Dificultad), se guarda
// una foto de los 4 valores. Ctrl+Z retrocede un paso en ese historial,
// Ctrl+Y (o Ctrl+Shift+Z) avanza. Los botones ↶ / ↷ junto a A-Z/BPM hacen
// lo mismo con el mouse/toque.
// OJO: filterMovSearchTexto (la búsqueda propia de la Lupa) queda AFUERA a
// propósito de este historial de 4 filtros: Ctrl+Z/Ctrl+Y no la tocan, sólo
// se limpia escribiendo otra búsqueda (o vaciando el campo) en la Lupa, o
// con el 🌈/F de "reset total" (ver resetearTodosLosFiltros).
let historialFiltros = [{ filterFigura: null, filterPosIni: null, filterPosFin: null, filterDificultad: null }];
let historialIndice = 0;

function snapshotFiltrosActual() {
    return { filterFigura, filterPosIni, filterPosFin, filterDificultad };
}

// Compara dos valores de UNA dimensión de filtro (Figura, Posición Inicial o
// Posición Final), tratando dos filtros de texto libre como "el mismo" si
// tienen el mismo texto normalizado (si no, cada Enter con el mismo texto
// generaría una entrada de historial nueva, por ser objetos distintos).
function valoresFiltroIguales(a, b) {
    const aEsTexto = esFiltroTexto(a);
    const bEsTexto = esFiltroTexto(b);
    if (aEsTexto || bEsTexto) return aEsTexto && bEsTexto && a.texto === b.texto;
    return a === b;
}

function mismosFiltros(a, b) {
    return valoresFiltroIguales(a.filterFigura, b.filterFigura) && valoresFiltroIguales(a.filterPosIni, b.filterPosIni) &&
        valoresFiltroIguales(a.filterPosFin, b.filterPosFin) && a.filterDificultad === b.filterDificultad;
}

// Se llama justo después de cada cambio real de filtro. Si el resultado
// coincide con la foto actual (p. ej. clic en el valor ya seleccionado), no
// agrega nada. Si hubo Deshacer de por medio, descarta el "futuro" (redo)
// antes de agregar el nuevo paso, como el Ctrl+Z de cualquier editor.
function registrarHistorialFiltros() {
    const snap = snapshotFiltrosActual();
    if (mismosFiltros(snap, historialFiltros[historialIndice])) return;
    historialFiltros = historialFiltros.slice(0, historialIndice + 1);
    historialFiltros.push(snap);
    historialIndice = historialFiltros.length - 1;
    actualizarBotonesHistorial();
}

function actualizarBotonesHistorial() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) undoBtn.disabled = historialIndice <= 0;
    if (redoBtn) redoBtn.disabled = historialIndice >= historialFiltros.length - 1;
}

// Aplica una foto del historial a los filtros reales y refresca todo lo que
// depende de ellos (grilla, desplegables, etiquetas), igual que un cambio
// de filtro manual.
function aplicarSnapshotFiltros(snap) {
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterFigura = snap.filterFigura;
    filterPosIni = snap.filterPosIni;
    filterPosFin = snap.filterPosFin;
    filterDificultad = snap.filterDificultad;
    recalcularComboActual();
    aplicarCambioVisual();
    renderFigureList(document.getElementById('fig-search').value);
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
    renderDificultadList();
    actualizarBotonesHistorial();
}

function deshacerFiltros() {
    if (historialIndice <= 0) return;
    historialIndice--;
    aplicarSnapshotFiltros(historialFiltros[historialIndice]);
}

function rehacerFiltros() {
    if (historialIndice >= historialFiltros.length - 1) return;
    historialIndice++;
    aplicarSnapshotFiltros(historialFiltros[historialIndice]);
}

document.getElementById('undo-btn').onclick = deshacerFiltros;
document.getElementById('redo-btn').onclick = rehacerFiltros;

function cambiarCancion(direccion) {
    const sortActive = document.getElementById('sort-abc').classList.contains('active') ? 'abc' : 'bpm';
    let sortedSongs = [...canciones];
    if (sortActive === 'abc') sortedSongs.sort((a, b) => a.name.localeCompare(b.name));
    else sortedSongs.sort((a, b) => a.bpm - b.bpm);
    const currentIndex = sortedSongs.findIndex(c => c.file === currentSongValue);
    if (currentIndex === -1) return;
    let newIndex = currentIndex + direccion;
    if (newIndex >= 0 && newIndex < sortedSongs.length) {
        if (isPlaying || !isFirstAction) mutearParaCarga();
        audioPlayer.pause();
        currentSongValue = sortedSongs[newIndex].file;
        localStorage.setItem('lastSong', currentSongValue);
        setDropdownSelectedHTML('song-selected', `🎧 ${sortedSongs[newIndex].name} [${sortedSongs[newIndex].bpm} BPM]`);
        prepararFuentes();
        if (isPlaying) {
            reiniciarDesdeCero(true);
        } else {
            isFirstAction = true;
            renderGrid();
        }
        renderSongList(document.getElementById('song-search').value, sortActive);
    }
}

// ===== FUNCIONES PRINCIPALES =====
function setupSelects() {
    filterFigura = null;
    filterPosIni = null;
    filterPosFin = null;
    filterDificultad = null;
    if (combosData.length > 0) {
        recalcularComboActual();
    }

    if (canciones.length > 0) {
        canciones.sort((a, b) => a.name.localeCompare(b.name));
        const savedSong = localStorage.getItem('lastSong');
        if (savedSong && canciones.some(c => c.file === savedSong)) {
            currentSongValue = savedSong;
        } else {
            currentSongValue = canciones[0].file;
        }
        const songObj = canciones.find(c => c.file === currentSongValue);
        setDropdownSelectedHTML('song-selected', `🎧 ${songObj.name} [${songObj.bpm} BPM]`);
    }

    renderFigureList();
    renderPosIniList();
    renderPosFinList();
    renderSongList("", 'abc');
}

// Determina qué Dificultad se muestra para el combo actual: si hay un filtro
// de Dificultad explícito (y el combo activo lo tiene), se respeta ese; si no,
// se elige automáticamente según la última preferencia guardada (más cercana
// disponible por abajo, igual que antes con MaxH).
function cargarDificultad() {
    const fig = currentFigureValue;
    if (!fig || !figurasData[fig]) { actualizarPaginacion(); return; }
    const niveles = Object.keys(figurasData[fig]);
    if (niveles.length === 0) { actualizarPaginacion(); return; }

    if (filterDificultad !== null && niveles.includes(filterDificultad)) {
        currentDificultadValue = filterDificultad;
    } else {
        const prefGuardadaStr = localStorage.getItem('preferredDificultad');
        const preferencia = prefGuardadaStr ? parseInt(prefGuardadaStr) : 1;
        let mejorCoincidencia = niveles[0];
        let maximoEncontrado = -1;
        niveles.forEach(d => {
            let numNivel = parseInt(d.replace('D', ''));
            if (numNivel <= preferencia && numNivel > maximoEncontrado) {
                maximoEncontrado = numNivel;
                mejorCoincidencia = d;
            }
        });
        currentDificultadValue = mejorCoincidencia;
    }

    currentVariantIndex = 0;
    actualizarEtiquetaDificultad();
    actualizarPaginacion();
}

// Muestra la Dificultad efectiva que se está reproduciendo. Si es un filtro
// explícito se muestra "seco" (D2); si es automática (sin filtro activo) se
// muestra solo el arcoiris, siempre igual, sin importar qué Dificultad se
// esté reproduciendo en cada paso (para que no cambie de cartel al navegar).
function actualizarEtiquetaDificultad() {
    setDropdownSelectedHTML('ver-selected', filterDificultad !== null
        ? currentDificultadValue
        : `🌈`);
}

// Arma la lista plana de TODAS las tomas (combinación + dificultad + variante)
// que cumplen los filtros activos. Cada Dificultad y cada variante dentro de
// una misma Dificultad (V2, V3, etc.) cuenta como un paso propio, así el total
// coincide con la cantidad real de videos subidos (p.ej. 101), no con la
// cantidad de combinaciones únicas de Posición/Figura/Posición (74).
function construirPasosFiltrados() {
    const candidatos = combosFiltrados(null).slice().sort(compararCombos);
    // Igual que los toggles "I"/"C"/"=": si "Mostrar figuras ocultas" está
    // activo, directamente no hay nada que excluir acá (se ven todas).
    const hiddenSteps = mostrarFigurasOcultas ? [] : getHiddenSteps();
    const pasos = [];
    candidatos.forEach(combo => {
        const dificultades = combo.dificultades || {};
        Object.keys(dificultades)
            .sort((a, b) => parseInt(a.replace('D', '')) - parseInt(b.replace('D', '')))
            .forEach(dif => {
                if (filterDificultad !== null && dif !== filterDificultad) return;
                const tomas = dificultades[dif] || [];
                tomas.forEach((toma, variantIndex) => {
                    if (hiddenSteps.length && pasoEstaOculto(hiddenSteps, combo.id, dif, variantIndex, toma)) return;
                    pasos.push({ comboId: combo.id, dificultad: dif, variantIndex });
                });
            });
    });
    return pasos;
}

// ¿Esta toma puntual (comboId+dificultad+variantIndex) está en la lista de
// ocultas? Se compara por código de 3 letras (identificador estable, ver
// extraerInfoArchivo) cuando el item oculto ya lo tiene guardado; si no
// (compatibilidad), se cae al variantIndex crudo — mismo criterio que usan
// los Favoritos (ver figuraActualYaEnListaActiva).
function pasoEstaOculto(hiddenSteps, comboId, dificultad, variantIndex, toma) {
    return hiddenSteps.some(it => {
        if (it.comboId !== comboId || it.dificultad !== dificultad) return false;
        if (it.letras) {
            const info = toma ? extraerInfoArchivo(toma.file8t) : null;
            if (info) return info.letras === it.letras;
        }
        return it.variantIndex === variantIndex;
    });
}

function indicePasoActual(pasos) {
    return pasos.findIndex(p =>
        p.comboId === currentFigureValue &&
        p.dificultad === currentDificultadValue &&
        p.variantIndex === currentVariantIndex
    );
}

// El contador y las flechas < > navegan entre TODAS las tomas que cumplen el
// filtro activo (101 si está todo en "Cualquiera", menos si hay figura,
// posición o dificultad elegidas).
function actualizarPaginacion() {
    const pasos = construirPasosFiltrados();
    const total = pasos.length;
    let idx = indicePasoActual(pasos);
    if (idx === -1) idx = 0;
    const pageInputEl = document.getElementById('page-indicator-input');
    const pageTotalEl = document.getElementById('page-indicator-total');
    // Si no hay ningún Movimiento, forzamos "0/0" siempre, incluso si el
    // usuario justo tenía el foco en el input tecleando un número (por
    // ejemplo, si al cambiar de figura el nuevo filtro queda en 0
    // resultados): no tiene sentido dejarle un número viejo con el total
    // ya en 0 (ej. "5/0").
    if (pageInputEl && (total === 0 || document.activeElement !== pageInputEl)) {
        pageInputEl.value = total === 0 ? 0 : idx + 1;
    }
    if (pageInputEl) {
        // Con 0 resultados, min/max también se ajustan a 0 para que el
        // input quede consistente con el valor mostrado (si no, min="1"
        // con value="0" queda incoherente aunque no se vea).
        pageInputEl.min = total === 0 ? 0 : 1;
        pageInputEl.max = total || 0;
        pageInputEl.disabled = (total === 0);
        // Ancho ajustado a la cantidad de dígitos actual (mínimo 1), para que
        // el número seleccionable quede tan compacto como el total de la
        // derecha en vez de verse suelto dentro de una caja más ancha.
        const digitos = String(pageInputEl.value || '1').length;
        pageInputEl.style.width = digitos + 'ch';
    }
    if (pageTotalEl) pageTotalEl.innerText = total;
    prevPageBtn.disabled = (idx <= 0);
    nextPageBtn.disabled = (idx >= total - 1);
    // Mismo estado que el paginador de arriba, para las flechitas < > que
    // están ancladas al centro vertical del video.
    if (videoPrevBtn) videoPrevBtn.disabled = prevPageBtn.disabled;
    if (videoNextBtn) videoNextBtn.disabled = nextPageBtn.disabled;
    // Las flechas de encadenar Posición Inicial/Final tampoco tienen sentido
    // si no hay ningún Movimiento para mostrar (no hay video del que sacar
    // la posición actual), así que se ocultan junto con las de navegación.
    const posIniSwapBtn = document.getElementById('posini-swap-btn');
    const posFinSwapBtn = document.getElementById('posfin-swap-btn');
    if (posIniSwapBtn) posIniSwapBtn.style.display = (total === 0) ? 'none' : '';
    if (posFinSwapBtn) posFinSwapBtn.style.display = (total === 0) ? 'none' : '';
    // Botón izquierdo (celeste): fija como Posición Inicial la Posición Final
    // que se ve AHORA, así que muestra el código de esa Posición Final.
    // Botón derecho (azul): al revés, muestra el código de la Posición
    // Inicial actual.
    if (total > 0) {
        const spanIni = posIniSwapBtn ? posIniSwapBtn.querySelector('span') : null;
        const spanFin = posFinSwapBtn ? posFinSwapBtn.querySelector('span') : null;
        if (spanIni) spanIni.innerText = codigoDePosicion(valorActualDelVideo('posFin'));
        if (spanFin) spanFin.innerText = codigoDePosicion(valorActualDelVideo('posIni'));
        // Inhabilitados (en gris) si no hay Posición (con nombre propio) para
        // encadenar, o si encadenarla dejaría 0 Movimientos por culpa de otro
        // filtro ya activo (Figura y/o Dificultad) — ver swapEncadenarDisponible.
        if (posIniSwapBtn) posIniSwapBtn.disabled = !swapEncadenarDisponible('posIni');
        if (posFinSwapBtn) posFinSwapBtn.disabled = !swapEncadenarDisponible('posFin');
    }
}

// Salta directamente al Movimiento N (1-based) tecleado en el indicador,
// dentro de las tomas que cumplen el filtro activo, igual que hacen las
// flechas < > pero sin tener que ir de a una.
function irAMovimientoNumero(numero) {
    const pasos = construirPasosFiltrados();
    const total = pasos.length;
    if (total === 0 || isNaN(numero)) {
        actualizarPaginacion();
        return;
    }
    let idx = Math.round(numero) - 1;
    idx = Math.max(0, Math.min(total - 1, idx));
    const actual = indicePasoActual(pasos);
    if (idx === actual) {
        actualizarPaginacion();
        return;
    }
    if (isPlaying || !isFirstAction) mutearParaCarga();
    const paso = pasos[idx];
    currentFigureValue = paso.comboId;
    currentDificultadValue = paso.dificultad;
    currentVariantIndex = paso.variantIndex;
    actualizarEtiquetaDificultad();
    aplicarCambioVisual();
}

// Mueve a la toma anterior/siguiente dentro de las que cumplen el filtro
// activo, sin tocar los filtros (si están en "Cualquiera" siguen así).
function moverCombo(direccion) {
    const pasos = construirPasosFiltrados();
    if (pasos.length === 0) return;
    let idx = indicePasoActual(pasos);
    if (idx === -1) idx = 0;
    const newIdx = idx + direccion;
    if (newIdx < 0 || newIdx >= pasos.length) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    const paso = pasos[newIdx];
    currentFigureValue = paso.comboId;
    currentDificultadValue = paso.dificultad;
    currentVariantIndex = paso.variantIndex;
    actualizarEtiquetaDificultad();
    aplicarCambioVisual();
}

function getRateLimits() {
    const songObj = canciones.find(c => c.file === currentSongValue);
    const minRate = songObj ? Math.min(0.01, 1 / songObj.bpm) : 0.01;
    return { min: minRate, max: 3.00 };
}

function actualizarVelocidades() {
    const songObj = canciones.find(c => c.file === currentSongValue);
    if (!songObj) return;
    const originalBpm = songObj.bpm;
    let factorManual = parseFloat(rateInput.value) || 1.0;
    audioPlayer.playbackRate = factorManual;
    const videoBaseRate = (originalBpm / 120.0) * factorManual;
    currentVideoRate = videoBaseRate;
    aplicarRateAVideos();
    bpmLabel.innerText = `${Math.round(originalBpm * factorManual)} BPM`;
}

function prepararFuentes() {
    if (!currentSongValue) return;
    audioPlayer.pause();
    audioPlayer.src = safeUrl(currentSongValue);
    audioPlayer.load();
    actualizarVelocidades();
}

function resetearVideos() {
    getAllMainVideos().forEach(v => {
        v.className = 'vid-visible';
        v.pause();
        v.currentTime = 0;
    });
    getAllLoopVideos().forEach(v => {
        v.className = 'vid-hidden';
        v.pause();
        v.currentTime = 0;
    });
}

function aplicarCambioVisual() {
    // Silenciar inmediatamente si hay audio sonando
    if (isPlaying || !isFirstAction) {
        mutearParaCarga();
    }
    audioPlayer.pause();
    if (!isPlaying && !isFirstAction) {
        isFirstAction = true;
        actualizarUI(false);
    }
    renderGrid();
    if (isPlaying) {
        reiniciarDesdeCero(true);
    }
    actualizarEstadoBotonFavAdd();
    actualizarEstadoBotonHide();
    actualizarEstadoBotonNota();
    actualizarEstadoBotonFavSaveFiltered();
    actualizarEstadoBotonPosIgual();
}

prevPageBtn.onclick = () => moverCombo(-1);

nextPageBtn.onclick = () => moverCombo(1);

if (videoPrevBtn) videoPrevBtn.onclick = () => moverCombo(-1);
if (videoNextBtn) videoNextBtn.onclick = () => moverCombo(1);

// Igual que moverCombo, pero sin ejecutar el cambio: sólo dice si hay
// Movimiento disponible en esa dirección (para el "rebote" del swipe).
function hayPasoDisponibleSwipe(direccion) {
    const pasos = construirPasosFiltrados();
    if (pasos.length === 0) return false;
    let idx = indicePasoActual(pasos);
    if (idx === -1) idx = 0;
    const newIdx = idx + direccion;
    return newIdx >= 0 && newIdx < pasos.length;
}

// ===== SWIPE HORIZONTAL SOBRE EL VIDEO (sólo táctil) =====
// Deslizar hacia la izquierda = siguiente Movimiento (si hay), hacia la
// derecha = anterior (si hay) — mismo destino que las flechas < > /
// video-prev-btn / video-next-btn. Con animación evidente: el video sigue
// al dedo mientras se arrastra, y al soltar, o termina de salir y el nuevo
// Movimiento entra deslizando desde el lado opuesto (si hay destino), o
// "rebota" de vuelta al centro (si no llegó al umbral, o no hay más
// Movimientos de ese lado — así se nota el "tope" sin cambiar nada).
(function() {
    const wrapper = document.getElementById('video-center-wrapper');
    if (!wrapper) return;
    const grid = videoGridWrapper; // mismo elemento ya obtenido arriba en el archivo
    if (!grid) return;

    const UMBRAL_X = 50; // píxeles mínimos horizontales para contar como swipe
    const UMBRAL_INTENCION = 8; // píxeles para decidir si el gesto es horizontal o vertical
    const DURACION_MS = 180;
    const TRANSICION = `transform ${DURACION_MS}ms ease, opacity ${DURACION_MS}ms ease`;

    let startX = 0;
    let startY = 0;
    let siguiendo = false; // el dedo está apoyado, todavía sin decidir si es swipe
    let arrastrando = false; // ya se confirmó que es un arrastre horizontal
    let anchoWrapper = 0;

    wrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { siguiendo = false; return; }
        anchoWrapper = wrapper.clientWidth || 300;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        siguiendo = true;
        arrastrando = false;
        grid.style.transition = 'none';
    }, { passive: true });

    wrapper.addEventListener('touchmove', (e) => {
        if (!siguiendo) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (!arrastrando) {
            if (Math.abs(dx) < UMBRAL_INTENCION && Math.abs(dy) < UMBRAL_INTENCION) return;
            // Si el gesto resulta ser más vertical que horizontal, se deja de
            // seguir del todo (no interfiere con scroll/pull vertical).
            if (Math.abs(dy) >= Math.abs(dx)) { siguiendo = false; return; }
            arrastrando = true;
        }
        // Sigue al dedo 1 a 1; si del lado hacia el que se arrastra no hay
        // Movimiento disponible, se mueve con resistencia (menos), para que
        // se note el "tope" incluso mientras se está arrastrando.
        const direccion = dx < 0 ? 1 : -1;
        const factor = hayPasoDisponibleSwipe(direccion) ? 1 : 0.35;
        const desplazamiento = dx * factor;
        grid.style.transform = `translateX(${desplazamiento}px)`;
        grid.style.opacity = String(Math.max(0.4, 1 - Math.abs(desplazamiento) / anchoWrapper));
    }, { passive: true });

    wrapper.addEventListener('touchend', (e) => {
        if (!siguiendo) return;
        siguiendo = false;
        if (!arrastrando) return; // fue un toque/tap normal, no un swipe

        const dx = e.changedTouches[0].clientX - startX;
        const direccion = dx < 0 ? 1 : -1;
        const cambiaDePagina = Math.abs(dx) >= UMBRAL_X && hayPasoDisponibleSwipe(direccion);

        grid.style.transition = TRANSICION;

        if (cambiaDePagina) {
            const salida = direccion === 1 ? -anchoWrapper : anchoWrapper;
            grid.style.transform = `translateX(${salida}px)`;
            grid.style.opacity = '0';
            setTimeout(() => {
                moverCombo(direccion);
                // El Movimiento nuevo arranca ya corrido hacia el lado
                // opuesto de por donde "salió" el anterior, y de ahí entra
                // deslizando hasta el centro.
                grid.style.transition = 'none';
                grid.style.transform = `translateX(${-salida}px)`;
                grid.style.opacity = '0';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        grid.style.transition = TRANSICION;
                        grid.style.transform = 'translateX(0)';
                        grid.style.opacity = '1';
                    });
                });
            }, DURACION_MS);
        } else {
            // No llegó al umbral, o no hay Movimiento de ese lado: rebota de
            // vuelta al centro sin cambiar nada.
            grid.style.transform = 'translateX(0)';
            grid.style.opacity = '1';
        }
    }, { passive: true });
})();

// ===== INPUT DE MOVIMIENTO (escribir un número para ir directo ahí) =====
(function () {
    const input = document.getElementById('page-indicator-input');
    if (!input) return;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => {
        // Ancho en vivo mientras se escribe (ej: al pasar de "9" a "12").
        const digitos = String(input.value || '').length || 1;
        input.style.width = digitos + 'ch';
    });
    input.addEventListener('keydown', (e) => {
        // Que Enter confirme el salto sin que además dispare atajos globales.
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            irAMovimientoNumero(parseInt(input.value, 10));
            input.blur();
        }
    });
    input.addEventListener('blur', () => {
        irAMovimientoNumero(parseInt(input.value, 10));
    });
})();

// ===== SINCRONIZACION REFORZADA =====

// Verifica que un video esté REALMENTE corriendo: currentTime debe avanzar.
// Lo reproduce oculto y mide si el tiempo avanza en dos lecturas separadas.
// Esto detecta congelamientos reales que canplaythrough no detecta.
function verificarVideoAvanzando(v, msObservacion) {
    return new Promise(resolve => {
        const t0 = v.currentTime;
        setTimeout(() => {
            // Si currentTime avanzó, el video está decodificando correctamente
            resolve(v.currentTime > t0 && !v.paused);
        }, msObservacion);
    });
}

async function reproducirSincronizado(forzarPlay = false) {
    if (!forzarPlay && !isPlaying) return;
    const currentSeq = ++loadSequence;
    audioPlayer.pause();

    const mainVideos = getAllMainVideos();
    const loopVideos = getAllLoopVideos();

    loadingIndicator.style.display = 'flex';

    // ── PASO 1: Reset completo ──────────────────────────────────────────────
    mainVideos.forEach(v => { v.pause(); v.currentTime = 0; v.load(); });
    loopVideos.forEach(v => { v.pause(); v.currentTime = 0; v.load(); });
    audioPlayer.currentTime = 0;
    audioPlayer.load();
    actualizarVelocidades();

    if (currentSeq !== loadSequence) return;

    // ── PASO 2: Reproducir todo en OCULTO y esperar que realmente arranque ──
    // La estrategia: arrancar los videos (que ya están opacity:0 por vid-visible/hidden
    // pero ocultos detrás del loading-indicator), medir que currentTime avance,
    // y solo mostrar cuando el decodificador confirme que corre sin trabas.
    //
    // El video-grid-wrapper tiene el loading encima (z-index 100), así que los
    // videos corren invisibles para el usuario durante esta fase.

    // Intentos: hasta 3 veces si un video se congela, con recarga intermedia
    const MAX_INTENTOS = 3;
    const MS_OBSERVACION = 400; // tiempo para verificar que currentTime avanza
    const MS_ENTRE_INTENTOS = 300;

    let todosOk = false;

    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        if (currentSeq !== loadSequence) return;

        // Esperar canplaythrough de cada video (señal mínima necesaria)
        const waitCanPlay = mainVideos.map(v => new Promise(resolve => {
            if (v.readyState >= 3) { resolve(); return; }
            const fn = () => { v.removeEventListener('canplaythrough', fn); resolve(); };
            v.addEventListener('canplaythrough', fn);
            setTimeout(resolve, 12000); // fallback 12s
        }));

        const waitAudio = new Promise(resolve => {
            if (audioPlayer.readyState >= 3) { resolve(); return; }
            const fn = () => { audioPlayer.removeEventListener('canplaythrough', fn); resolve(); };
            audioPlayer.addEventListener('canplaythrough', fn);
            setTimeout(resolve, 12000);
        });

        await Promise.race([
            Promise.all([waitAudio, ...waitCanPlay]),
            new Promise(r => setTimeout(r, 15000))
        ]);

        if (currentSeq !== loadSequence) return;

        // Arrancar todos los videos en oculto (el loading sigue visible encima)
        mainVideos.forEach(v => { v.currentTime = 0; });
        try {
            await Promise.all(mainVideos.map(v => v.play().catch(() => {})));
        } catch(e) {}

        if (currentSeq !== loadSequence) return;

        // Observar MS_OBSERVACION ms: ¿todos los videos están avanzando?
        await new Promise(r => setTimeout(r, MS_OBSERVACION));
        if (currentSeq !== loadSequence) return;

        const resultados = mainVideos.map(v => v.currentTime > 0 && !v.paused);
        todosOk = resultados.every(ok => ok);

        if (todosOk) break;

        // Algún video se congeló: pause, reload y reintentar
        mainVideos.forEach(v => { v.pause(); v.currentTime = 0; v.load(); });
        await new Promise(r => setTimeout(r, MS_ENTRE_INTENTOS));
    }

    if (currentSeq !== loadSequence) return;

    // ── PASO 3: Pausar, rebobinar, y esperar audio ──────────────────────────
    // Los videos ya demostraron que pueden correr. Los pausamos y rebobinamos
    // para el arranque sincronizado real.
    mainVideos.forEach(v => { v.pause(); v.currentTime = 0; });

    // Esperar que el audio también esté listo
    if (audioPlayer.readyState < 3) {
        await Promise.race([
            new Promise(resolve => {
                const fn = () => { audioPlayer.removeEventListener('canplaythrough', fn); resolve(); };
                audioPlayer.addEventListener('canplaythrough', fn);
            }),
            new Promise(r => setTimeout(r, 10000))
        ]);
    }

    // Pre-cargar loop videos en background (no bloquea el arranque)
    loopVideos.forEach(v => { v.currentTime = 0; v.load(); });

    if (currentSeq !== loadSequence) return;

    // Pequeña pausa para que el rebobinado y el buffer se asienten
    await new Promise(r => setTimeout(r, 80));
    if (currentSeq !== loadSequence) return;

    // ── PASO 4: Arranque real sincronizado ──────────────────────────────────
    loadingIndicator.style.display = 'none';
    desmutearTrasCarga();
    isPlaying = true;

    try {
        audioPlayer.currentTime = 0;
        loopVideos.forEach(v => { v.currentTime = 0; v.className = 'vid-hidden'; });
        mainVideos.forEach(v => { v.currentTime = 0; v.className = 'vid-visible'; });

        // Video(s) y canción se piden arrancar juntos en el mismo
        // Promise.all (en vez de esperar primero a que los videos terminen
        // de arrancar y RECIÉN AHÍ pedirle play a la canción): ese pasito
        // secuencial de más era justamente el hueco que a veces se notaba
        // como un pequeño defasaje entre la canción y el video al cambiar
        // de Movimiento.
        await Promise.all([...mainVideos.map(v => v.play()), audioPlayer.play()]);

        if (currentSeq !== loadSequence) {
            mainVideos.forEach(v => v.pause());
            audioPlayer.pause();
            return;
        }
        actualizarUI(true);
        isFirstAction = false;
    } catch (e) {
        if (currentSeq === loadSequence) {
            desmutearTrasCarga();
            isPlaying = false;
            actualizarUI(false);
        }
    }
}

function reiniciarDesdeCero(forzarPlay = false) {
    audioPlayer.pause();
    resetearVideos();
    actualizarVelocidades();
    audioPlayer.currentTime = 0;
    if (forzarPlay) {
        reproducirSincronizado(true);
    }
}

// ===== ORDEN DE CANCIONES CON COOKIE =====
document.getElementById('sort-abc').onclick = (e) => {
    document.getElementById('sort-bpm').classList.remove('active');
    e.target.classList.add('active');
    setCookie('songSort', 'abc');
    renderSongList(document.getElementById('song-search').value, 'abc');
    forzarPrimeraCancionYReiniciar();
};

document.getElementById('sort-bpm').onclick = (e) => {
    document.getElementById('sort-abc').classList.remove('active');
    e.target.classList.add('active');
    setCookie('songSort', 'bpm');
    renderSongList(document.getElementById('song-search').value, 'bpm');
    forzarPrimeraCancionYReiniciar();
};

// ===== BOTONES UI =====
playBtn.onclick = () => {
    if (isFirstAction) {
        reiniciarDesdeCero(true);
    } else {
        if (!isPlaying) {
            isPlaying = true;
            actualizarVelocidades();
            const allVids = getAllVideos();
            const activeVids = allVids.filter(v => v.className === 'vid-visible');
            Promise.all(activeVids.map(v => v.play())).then(() => {
                audioPlayer.play().then(() => {
                    actualizarUI(true);
                }).catch(() => {
                    isPlaying = false;
                    actualizarUI(false);
                });
            }).catch(() => {
                isPlaying = false;
                actualizarUI(false);
            });
        } else {
            isPlaying = false;
            audioPlayer.pause();
            getAllVideos().forEach(v => v.pause());
            actualizarUI(false);
        }
    }
};

function actualizarUI(reproduciendo) {
    if (reproduciendo) {
        playBtn.className = "btn-red";
        playBtn.title = "Detener (Espacio)";
        playIcon.innerHTML = "■";
        playIcon.className = "icon-stop";
        playIcon.title = "Detener (Espacio)";
    } else {
        playBtn.className = isFirstAction ? "btn-yellow" : "btn-green";
        playBtn.title = "Reproducir (Espacio)";
        playIcon.innerHTML = "▶";
        playIcon.className = "icon-play";
        playIcon.title = "Reproducir (Espacio)";
    }
}

document.getElementById('refresh-btn').onclick = () => reiniciarDesdeCero(true);

document.getElementById('controls-reset-btn').onclick = () => resetearTodosLosFiltros();

document.getElementById('mute-btn').onclick = (e) => {
    audioPlayer.muted = !audioPlayer.muted;
    e.target.innerText = audioPlayer.muted ? "🔇" : "🔊";
};

// Antes era un botón "T" suelto en la barra de controles; ahora vive como
// opción dentro del menú (☰), pero la función es la misma (y la sigue
// usando el atajo de teclado "t").
function toggleMostrarTitulo() {
    mostrarTitulo = !mostrarTitulo;
    localStorage.setItem('mostrarTitulo', mostrarTitulo ? '1' : '0');
    document.getElementById('menu-title-toggle-item').classList.toggle('active', mostrarTitulo);
    renderGrid();
}

// ===== MENÚ (☰): descargar para modo avión + mostrar código identificador =====
document.getElementById('menu-btn').onclick = (e) => {
    e.stopPropagation();
    toggleDropdown('menu-options-panel', () => actualizarEtiquetaFigurasOcultas());
};
document.getElementById('menu-options-panel').onclick = e => e.stopPropagation();

document.getElementById('menu-download-item').onclick = () => {
    if ('serviceWorker' in navigator && window.requestOfflineDownload) {
        window.requestOfflineDownload();
    }
    closeAllDropdowns();
};

document.getElementById('menu-title-toggle-item').onclick = () => {
    toggleMostrarTitulo();
    closeAllDropdowns();
};

// "🧹 Borrar caché y actualizar": desregistra el Service Worker y borra TODO
// lo que tenga cacheado (shell de la app + lo descargado para modo avión,
// porque ambos viven en el mismo cache — ver sw.js), y recarga con un query
// nuevo para asegurarse de traer la última versión real de la red, no una
// copia vieja del caché HTTP del navegador. Es destructivo (borra los
// videos/canciones descargados), así que pide confirmación antes.
// "🧹 Borrar caché y actualizar": además de lo de siempre (desregistra el SW
// y borra TODO lo cacheado), ahora también borra explícitamente las listas
// de Favoritos y las Figuras ocultas, a pedido explícito (antes esas dos
// cosas vivían fuera del cache/SW y sobrevivían intactas a este botón, algo
// que ya no es lo que se espera de la opción "sin conservar").
// "🧹 ... (conservando mis favoritos y ocultos)": mismo borrado de cache/SW,
// pero además resguarda esas cookies/localStorage ANTES de borrar y las
// vuelve a escribir después, como garantía extra pase lo que pase con el
// resto del proceso.
async function borrarCacheYActualizar(conservarFavoritos) {
    const backupFavLists = conservarFavoritos ? getCookie('favLists') : null;
    const backupFavActiveListId = conservarFavoritos ? getCookie('favActiveListId') : null;
    const backupHiddenSteps = conservarFavoritos ? localStorage.getItem('hiddenSteps') : null;
    const backupNotas = conservarFavoritos ? getCookie('notas') : null;
    try {
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((reg) => reg.unregister()));
        }
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
    } catch (err) {
        console.warn('No se pudo limpiar el caché por completo', err);
    } finally {
        if (conservarFavoritos) {
            if (backupFavLists !== null) setCookie('favLists', backupFavLists);
            if (backupFavActiveListId !== null) setCookie('favActiveListId', backupFavActiveListId);
            if (backupHiddenSteps !== null) localStorage.setItem('hiddenSteps', backupHiddenSteps);
            if (backupNotas !== null) setCookie('notas', backupNotas);
        } else {
            setCookie('favLists', '', -1);
            setCookie('favActiveListId', '', -1);
            localStorage.removeItem('hiddenSteps');
            setCookie('notas', '', -1);
        }
        window.location.href = window.location.pathname + '?_upd=' + Date.now();
    }
}

// "🗑️ Borrar mis favoritos, ocultos y notas": a diferencia de "🧹 Borrar
// caché", esto NO toca el Service Worker ni lo descargado para modo avión —
// sólo vacía las 3 cosas que vive fuera del caché (listas de favoritos,
// Figuras ocultas y notas), sin recargar la página. Pide confirmación
// porque es irreversible (no hay backup automático; para eso está
// "⬆️ Exportar" antes de hacer esto, si se quiere conservar una copia).
document.getElementById('menu-clear-favs-item').onclick = () => {
    closeAllDropdowns();
    const confirmado = confirm('Esto borra tus listas de favoritos, tus Figuras ocultas y tus notas guardadas en este dispositivo. No afecta lo descargado para modo avión. Si querés conservar una copia, cancelá y usá "Exportar" antes. ¿Continuar?');
    if (!confirmado) return;

    guardarFavLists([]);
    setFavActiveListId(null);
    favExpandedListIds.clear();
    guardarHiddenSteps([]);
    guardarNotas([]);

    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    actualizarEstadoBotonHide();
    actualizarEstadoBotonNota();
    actualizarEtiquetaFigurasOcultas();
    actualizarNotaEnVideo('');
    renderFavListDropdown();
    aplicarCambioVisual();
    actualizarPaginacion();
};

document.getElementById('menu-clear-cache-item').onclick = async () => {
    closeAllDropdowns();
    const confirmado = confirm('Esto borra todo lo guardado en este dispositivo (incluido lo descargado para modo avión, tus listas de favoritos, tus Figuras ocultas y tus notas) y recarga la última versión de la app. ¿Continuar?');
    if (!confirmado) return;
    borrarCacheYActualizar(false);
};

document.getElementById('menu-clear-cache-keep-favs-item').onclick = async () => {
    closeAllDropdowns();
    const confirmado = confirm('Esto borra el caché de la app y lo descargado para modo avión, y recarga la última versión. Tus listas de favoritos, tus Figuras ocultas y tus notas se mantienen. ¿Continuar?');
    if (!confirmado) return;
    borrarCacheYActualizar(true);
};

// ===== EXPORTAR / IMPORTAR (favoritos, ocultos y notas) =====
// Busca, en TODOS los combos y TODAS las Dificultades del manifest actual,
// la toma cuyo código de 3 letras coincide con el buscado. Se usa al
// importar un backup: el backup sólo guarda ese código (nunca comboId,
// Dificultad ni variantIndex), porque esos sí pueden cambiar si el glosario
// se reorganiza más adelante — el código de 3 letras del archivo es el
// único dato realmente estable a largo plazo. Devuelve
// {comboId, dificultad, variantIndex} o null si ese código ya no existe en
// ninguna toma actual.
function buscarTomaPorLetrasGlobal(letras) {
    if (!letras) return null;
    for (const combo of combosData) {
        const difs = combo.dificultades || {};
        for (const dif of Object.keys(difs)) {
            const tomas = difs[dif];
            const idx = tomas.findIndex(t => {
                const info = extraerInfoArchivo(t.file8t);
                return info && info.letras === letras;
            });
            if (idx !== -1) return { comboId: combo.id, dificultad: dif, variantIndex: idx };
        }
    }
    return null;
}

// Junta todo lo que vive fuera del caché/SW (y por lo tanto NO se puede
// recuperar re-descargando la app) en un único objeto, para poder
// respaldarlo y restaurarlo a mano en otro dispositivo o después de perder
// los datos de este. Sólo se guarda el código de 3 letras de cada toma (ver
// buscarTomaPorLetrasGlobal): ni comboId, ni Dificultad, ni variantIndex,
// porque esos son datos que pueden cambiar con el tiempo.
function construirBackupCompleto() {
    const lists = migrarLetrasFavLists(getFavLists());
    return JSON.stringify({
        favLists: lists.map(l => ({ name: l.name, letras: l.items.map(it => it.letras).filter(Boolean) })),
        hiddenSteps: getHiddenSteps().map(it => it.letras).filter(Boolean),
        notas: getNotas().filter(it => it.letras).map(it => ({ letras: it.letras, texto: it.texto })),
    });
}

// Reconstruye, a partir de los códigos de 3 letras del backup, listas de
// Favoritos / Figuras ocultas / Notas nuevas y frescas (con el comboId,
// Dificultad y variantIndex ACTUALES de cada código). Los códigos que ya no
// existan en el glosario de hoy simplemente se descartan.
function aplicarBackupCompleto(data) {
    if (Array.isArray(data.favLists)) {
        const lists = data.favLists.map(l => ({
            id: generarFavListId(),
            name: l.name || siguienteNombreListaDisponible(),
            items: (l.letras || []).map(letras => {
                const resuelto = buscarTomaPorLetrasGlobal(letras);
                return resuelto ? { comboId: resuelto.comboId, dificultad: resuelto.dificultad, variantIndex: resuelto.variantIndex, letras } : null;
            }).filter(Boolean),
        }));
        guardarFavLists(lists);
        setFavActiveListId(lists.length ? lists[0].id : null);
    }
    if (Array.isArray(data.hiddenSteps)) {
        const hidden = data.hiddenSteps.map(letras => {
            const resuelto = buscarTomaPorLetrasGlobal(letras);
            return resuelto ? { comboId: resuelto.comboId, dificultad: resuelto.dificultad, variantIndex: resuelto.variantIndex, letras } : null;
        }).filter(Boolean);
        guardarHiddenSteps(hidden);
    }
    if (Array.isArray(data.notas)) {
        const notas = data.notas.map(n => {
            const resuelto = buscarTomaPorLetrasGlobal(n.letras);
            return resuelto ? { comboId: resuelto.comboId, dificultad: resuelto.dificultad, variantIndex: resuelto.variantIndex, letras: n.letras, texto: n.texto } : null;
        }).filter(Boolean);
        guardarNotas(notas);
    }
}

// "⬆️ Exportar...": muestra el JSON completo en un prompt de sólo lectura de
// hecho (el usuario puede cancelar sin que se modifique nada), listo para
// seleccionar y copiar.
document.getElementById('menu-export-item').onclick = () => {
    closeAllDropdowns();
    prompt('Copiá este texto y guardalo en un lugar seguro (Ctrl+C / Cmd+C, después Cancelar o Aceptar, da igual):', construirBackupCompleto());
};

// "⬇️ Importar...": pide pegar un texto exportado antes, y si es un JSON
// válido, reemplaza favoritos/ocultos/notas actuales por esos (con
// confirmación previa, porque pisa lo que ya hubiera).
document.getElementById('menu-import-item').onclick = () => {
    closeAllDropdowns();
    const texto = prompt('Pegá acá el texto que generó "Exportar" antes:', '');
    if (texto === null || texto.trim() === '') return;
    let data;
    try {
        data = JSON.parse(texto);
    } catch (e) {
        alert('Ese texto no es un backup válido.');
        return;
    }
    if (!confirm('Esto reemplaza tus listas de favoritos, tus Figuras ocultas y tus notas actuales por las del texto pegado. ¿Continuar?')) return;
    aplicarBackupCompleto(data);
    actualizarEtiquetaFavLista();
    actualizarEstadoBotonFavAdd();
    actualizarEstadoBotonHide();
    actualizarEstadoBotonNota();
    actualizarEtiquetaFigurasOcultas();
    renderFavListDropdown();
    aplicarCambioVisual();
    actualizarPaginacion();
};

// "🙉 Mostrar figuras ocultas" (tildable, apagado por defecto): mientras
// está activo, las tomas ocultas vuelven a aparecer en toda la navegación
// (paginación, flechas, grilla) sin necesidad de restablecerlas una por
// una. No desregistra ni borra nada: solo cambia qué pasos entran en
// construirPasosFiltrados, así que alcanza con refrescar la pantalla.
document.getElementById('menu-show-hidden-toggle-item').onclick = () => {
    mostrarFigurasOcultas = !mostrarFigurasOcultas;
    setCookie('mostrarFigurasOcultas', mostrarFigurasOcultas ? '1' : '0');
    document.getElementById('menu-show-hidden-toggle-item').classList.toggle('active', mostrarFigurasOcultas);
    aplicarCambioVisual();
    actualizarPaginacion();
    closeAllDropdowns();
};

// Refresca el texto de "♻️ Restablecer todas las figuras ocultas", agregando
// al final "- [X]" con la cantidad de tomas ocultas guardadas ahora mismo
// (mismo patrón que "📋 Mi Lista - [N]" en el selector de Favoritos).
function actualizarEtiquetaFigurasOcultas() {
    const el = document.querySelector('#menu-reset-hidden-item .menu-item-label');
    if (!el) return;
    el.innerText = `♻️ Restablecer todas las figuras ocultas - [${getHiddenSteps().length}]`;
}

// "♻️ Restablecer todas las figuras ocultas": vacía la lista de ocultas por
// completo. No es destructivo para nada más (las Figuras solo vuelven a
// aparecer), así que no pide confirmación.
document.getElementById('menu-reset-hidden-item').onclick = () => {
    guardarHiddenSteps([]);
    actualizarEtiquetaFigurasOcultas();
    aplicarCambioVisual();
    actualizarPaginacion();
    closeAllDropdowns();
};

// ===== MODAL: TODOS LOS ATAJOS DE TECLADO CARGADOS =====
// Lista a mano, en el mismo orden en que aparecen los "case" del switch de
// abajo, para que quede documentado cada atajo que la app realmente escucha.
const HOTKEYS_INFO = [
    { keys: ['Espacio'], desc: 'Reproducir / Pausar' },
    { keys: ['S'], desc: 'Cambiar el orden de canciones (A-Z / BPM)' },
    { keys: ['R'], desc: 'Reiniciar el movimiento actual desde el principio' },
    { keys: ['M'], desc: 'Silenciar / Activar el sonido' },
    { keys: ['T'], desc: 'Mostrar u ocultar el código identificador' },
    { keys: ['B'], desc: 'Agregar la Figura actual a la lista de Favoritos seleccionada' },
    { keys: ['I'], desc: 'Activar/desactivar "=": mostrar sólo tomas con Posición Inicial y Final iguales' },
    { keys: ['O'], desc: 'Ocultar / Mostrar el movimiento actual' },
    { keys: ['N'], desc: 'Anotar / Editar la nota personal del movimiento actual' },
    { keys: ['L'], desc: 'Buscar un Movimiento por código o por texto libre (Dificultad/Posición/Figura)' },
    { keys: ['Enter'], desc: 'En Figura / Posición Inicial / Posición Final / Buscador de Movimiento (L): escribir un texto y confirmar (sin elegir un ítem puntual) filtra por TODAS las que contengan ese texto (ej. "Doble Péndulo" agrupa Cruzado y Paralelo; en el Buscador de Movimiento, se aplica como filtro de Figura)' },
    { keys: ['+'], desc: 'Aumentar la velocidad' },
    { keys: ['-'], desc: 'Disminuir la velocidad' },
    { keys: ['A'], desc: 'Canción anterior' },
    { keys: ['D'], desc: 'Canción siguiente' },
    { keys: ['1', '2', '3', '4', '5'], desc: 'Ir directo a esa Dificultad (D1 a D5)' },
    { keys: ['0', '|'], desc: 'Dificultad en "Cualquiera"' },
    { keys: ['← Flecha Izq'], desc: 'Movimiento anterior' },
    { keys: ['→ Flecha Der'], desc: 'Movimiento siguiente' },
    { keys: ['↑ Flecha Arr', 'Q'], desc: 'Retroceder un valor en la última dimensión tocada (Figura, Posición Inicial, Posición Final o Dificultad)' },
    { keys: ['↓ Flecha Abj', 'E'], desc: 'Avanzar un valor en esa misma dimensión' },
    { keys: ['W'], desc: 'Poner en "Cualquiera" sólo la dimensión tocada por última vez' },
    { keys: ['F'], desc: 'Reiniciar TODOS los filtros (Figura, Dificultad, Posición Inicial y Final)' },
    { keys: ['Ctrl', 'Z'], desc: 'Deshacer el último cambio de filtros' },
    { keys: ['Ctrl', 'Y'], desc: 'Rehacer el cambio de filtros deshecho' },
];

function renderHotkeysModal() {
    const body = document.getElementById('hotkeys-modal-body');
    if (!body) return;
    body.innerHTML = HOTKEYS_INFO.map(h => `
        <div class="hotkey-row">
            <div class="hotkey-keys">${h.keys.map(k => `<span class="hotkey-key">${k}</span>`).join('')}</div>
            <div class="hotkey-desc">${h.desc}</div>
        </div>
    `).join('');
}

const hotkeysModalOverlay = document.getElementById('hotkeys-modal-overlay');
document.getElementById('menu-hotkeys-item').onclick = () => {
    renderHotkeysModal();
    if (hotkeysModalOverlay) hotkeysModalOverlay.style.display = 'flex';
    closeAllDropdowns();
};
document.getElementById('hotkeys-modal-close').onclick = () => {
    if (hotkeysModalOverlay) hotkeysModalOverlay.style.display = 'none';
    sincronizarHistorialOverlay();
};
if (hotkeysModalOverlay) {
    hotkeysModalOverlay.onclick = (e) => {
        if (e.target === hotkeysModalOverlay) {
            hotkeysModalOverlay.style.display = 'none';
            sincronizarHistorialOverlay();
        }
    };
}
document.getElementById('hotkeys-modal').onclick = e => e.stopPropagation();

rateInput.oninput = actualizarVelocidades;
rateInput.onchange = () => {
    let val = parseFloat(rateInput.value);
    const limits = getRateLimits();
    if (val > limits.max) val = limits.max;
    if (val < limits.min) val = limits.min;
    rateInput.value = val.toFixed(2);
    actualizarVelocidades();
};

document.getElementById('rate-minus').onclick = () => {
    const limits = getRateLimits();
    let val = parseFloat(rateInput.value) - 0.01;
    if (val < limits.min) val = limits.min;
    rateInput.value = val.toFixed(2);
    actualizarVelocidades();
};

document.getElementById('rate-plus').onclick = () => {
    const limits = getRateLimits();
    let val = parseFloat(rateInput.value) + 0.01;
    if (val > limits.max) val = limits.max;
    rateInput.value = val.toFixed(2);
    actualizarVelocidades();
};

// ===== EVENTOS AUDIO =====
audioPlayer.onended = () => {
    if (isPlaying) {
        reiniciarDesdeCero(true);
    }
};

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (isPlaying) {
            reiniciarDesdeCero(true);
        } else {
            isFirstAction = true;
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            renderGrid();
            actualizarUI(false);
        }
    }
});

// ===== ATAJOS DE TECLADO =====
document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    // Con el modal de "Atajos de teclado" abierto, sólo Escape hace algo
    // (cerrarlo) — así evitamos disparar Espacio/flechas/etc. sin querer
    // mientras se está leyendo la lista.
    const hotkeysModal = document.getElementById('hotkeys-modal-overlay');
    if (hotkeysModal && hotkeysModal.style.display === 'flex') {
        if (key === 'escape') { e.preventDefault(); hotkeysModal.style.display = 'none'; sincronizarHistorialOverlay(); }
        return;
    }

    // Ctrl+Z / Ctrl+Y (o Ctrl+Shift+Z): deshacer/rehacer cambios de filtros
    // (Figura, Dificultad, Posición Inicial, Posición Final). Tiene prioridad
    // sobre cualquier otro atajo, salvo con el modal de atajos abierto.
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) rehacerFiltros(); else deshacerFiltros();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        rehacerFiltros();
        return;
    }

    // Con alguno de los desplegables (Figura, Dificultad, Posición Inicial,
    // Posición Final o Canción) abierto, Flecha Arriba/Abajo sólo mueven un
    // resaltado visual dentro de esa lista (sin aplicar nada todavía), Enter
    // confirma el ítem resaltado, y Escape cierra el desplegable. Esto tiene
    // prioridad incluso con el foco puesto en el buscador de texto.
    const openDropdown = getOpenDropdown();
    if (openDropdown && (key === 'arrowup' || key === 'arrowdown' || key === 'enter' || key === 'escape')) {
        e.preventDefault();
        if (key === 'arrowup') navigateDropdownHighlight(openDropdown.listId, -1);
        else if (key === 'arrowdown') navigateDropdownHighlight(openDropdown.listId, 1);
        else if (key === 'enter') {
            // En Figura / Posición Inicial / Posición Final / Movimiento
            // (🔍, L): si no hay nada resaltado con las flechas (o sea, el
            // usuario sólo tipeó texto y apretó Enter directo), ese texto se
            // aplica como filtro de "texto libre" (ver aplicarFiltroTextoLibre),
            // agrupando de una sola vez todos los Movimientos que lo
            // contengan. Si SÍ hay algo resaltado (se navegó con flechas
            // hasta un ítem puntual), Enter sigue confirmando ESE ítem
            // exacto, como siempre.
            const configTextoLibre = PANEL_A_FILTRO_TEXTO_LIBRE[openDropdown.panelId];
            const listaAbierta = document.getElementById(openDropdown.listId);
            const hayResaltado = listaAbierta && listaAbierta.querySelector('.dropdown-item.kbd-highlight');
            let aplicado = false;
            if (!hayResaltado && configTextoLibre) {
                const inputEl = document.getElementById(configTextoLibre.inputId);
                aplicado = aplicarFiltroTextoLibre(configTextoLibre.dimension, inputEl ? inputEl.value : '');
            }
            if (!aplicado) confirmDropdownHighlight(openDropdown.listId);
        }
        else if (key === 'escape') closeAllDropdowns();
        return;
    }

    const isRateInput = e.target.id === 'rate-input';
    const isOtherInput = e.target.tagName.toLowerCase() === 'input' && !isRateInput;
    if (isOtherInput) return;

    const hotkeys = [' ', 's', 'r', 'm', 't', 'b', 'l', 'i', 'o', '+', '-', 'a', 'd', 'q', 'e', 'w', 'f', '0', '1', '2', '3', '4', '5', '|', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
    if (isRateInput && hotkeys.includes(key)) {
        e.preventDefault();
        e.target.blur();
    }

    switch(key) {
        case ' ':
            e.preventDefault();
            playBtn.click();
            break;
        case 's':
            e.preventDefault();
            if (document.getElementById('sort-abc').classList.contains('active')) {
                document.getElementById('sort-bpm').click();
            } else {
                document.getElementById('sort-abc').click();
            }
            break;
        case 'r':
            document.getElementById('refresh-btn').click();
            break;
        case 'm':
            document.getElementById('mute-btn').click();
            break;
        case 't':
            toggleMostrarTitulo();
            break;
        case 'b':
            e.preventDefault();
            document.getElementById('fav-add-current-btn').click();
            break;
        case 'l':
            e.preventDefault();
            document.getElementById('movsearch-btn').click();
            break;
        case 'i':
            e.preventDefault();
            document.getElementById('pos-igual-btn').click();
            break;
        case 'o':
            e.preventDefault();
            document.getElementById('fig-hide-current-btn').click();
            break;
        case 'n':
            e.preventDefault();
            document.getElementById('fig-note-btn').click();
            break;
        case '+':
            e.preventDefault();
            const limitsPlus = getRateLimits();
            let valPlus = parseFloat(rateInput.value) + 0.01;
            if (valPlus > limitsPlus.max) valPlus = limitsPlus.max;
            rateInput.value = valPlus.toFixed(2);
            actualizarVelocidades();
            break;
        case '-':
            e.preventDefault();
            const limitsMinus = getRateLimits();
            let valMinus = parseFloat(rateInput.value) - 0.01;
            if (valMinus < limitsMinus.min) valMinus = limitsMinus.min;
            rateInput.value = valMinus.toFixed(2);
            actualizarVelocidades();
            break;
        case 'a':
            e.preventDefault();
            cambiarCancion(-1);
            break;
        case 'd':
            e.preventDefault();
            cambiarCancion(1);
            break;
        case '1': case '2': case '3': case '4': case '5':
            e.preventDefault();
            const targetDificultad = `D${e.key}`;
            if (!nivelesDificultadDisponibles().includes(targetDificultad) || filterDificultad === targetDificultad) break;
            if (isPlaying || !isFirstAction) mutearParaCarga();
            ultimaDimensionSeleccionada = 'dificultad';
            localStorage.setItem('preferredDificultad', e.key);
            filterDificultad = targetDificultad;
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
            break;
        case '|':
        case '0':
            e.preventDefault();
            if (filterDificultad === null) break;
            if (isPlaying || !isFirstAction) mutearParaCarga();
            ultimaDimensionSeleccionada = 'dificultad';
            filterDificultad = null;
            recalcularComboActual();
            aplicarCambioVisual();
            registrarHistorialFiltros();
            break;
        case 'arrowleft':
            e.preventDefault();
            if (!prevPageBtn.disabled) prevPageBtn.click();
            break;
        case 'arrowright':
            e.preventDefault();
            if (!nextPageBtn.disabled) nextPageBtn.click();
            break;
        case 'arrowup':
        case 'q':
            e.preventDefault();
            cambiarPorFlechas(-1);
            break;
        case 'arrowdown':
        case 'e':
            e.preventDefault();
            cambiarPorFlechas(1);
            break;
        case 'w':
            e.preventDefault();
            resetearDimensionActual();
            break;
        case 'f':
            e.preventDefault();
            resetearTodosLosFiltros();
            break;
    }
});

// ===== INICIO =====
document.getElementById('menu-title-toggle-item').classList.toggle('active', mostrarTitulo);
document.getElementById('menu-show-hidden-toggle-item').classList.toggle('active', mostrarFigurasOcultas);
document.getElementById('fig-individualizar-btn').classList.toggle('active', mostrarFigurasIndividuales);
document.getElementById('fig-combos-btn').classList.toggle('active', mostrarCombos);
document.getElementById('pos-igual-btn').classList.toggle('active', filtroPosIgual);
actualizarEstadoBotonPosIgual();
actualizarEtiquetaFavLista();

const savedSort = getCookie('songSort');
if (savedSort === 'bpm') {
    document.getElementById('sort-abc').classList.remove('active');
    document.getElementById('sort-bpm').classList.add('active');
}

window.appReadyPromise = iniciarApp();

// ===== PULL TO RELOAD (SOLO MOVIL) =====
(function() {
    const THRESHOLD = 80;
    const indicator = document.getElementById('pull-indicator');
    if (!indicator) return;

    // Con algún desplegable (Figura, Canción, Posición, el menú ☰, el
    // buscador de Movimiento, la lista de favoritos) o el modal de Atajos
    // de teclado abiertos, scrollear/arrastrar hacia abajo DENTRO de ese
    // panel no debe disparar el "pull to reload" de toda la página — sólo
    // tiene sentido estando libre de menús y submenús.
    // Reutiliza el mismo chequeo que usa el manejo del botón "atrás" del
    // teléfono (ver hayAlgunOverlayAbierto, más arriba en este archivo).
    const hayMenuOAtajosAbiertos = hayAlgunOverlayAbierto;

    let startY = 0;
    let pulling = false;

    document.addEventListener('touchstart', (e) => {
        if (window.scrollY === 0 && e.touches.length === 1 && !hayMenuOAtajosAbiertos()) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        // Si un menú se abrió recién durante el gesto (ej. tocaste un botón
        // y arrastraste el dedo), se cancela el pull en vez de completarlo.
        if (hayMenuOAtajosAbiertos()) {
            pulling = false;
            indicator.style.top = '-60px';
            indicator.classList.remove('pull-spinning');
            return;
        }
        const dist = Math.max(0, e.touches[0].clientY - startY);
        if (dist > 0) {
            const progress = Math.min(dist / THRESHOLD, 1);
            const top = -60 + (progress * 70);
            indicator.style.top = `${top}px`;
            if (dist >= THRESHOLD) {
                indicator.classList.add('pull-spinning');
            } else {
                indicator.classList.remove('pull-spinning');
            }
        }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (!pulling) return;
        pulling = false;
        if (hayMenuOAtajosAbiertos()) {
            indicator.style.top = '-60px';
            indicator.classList.remove('pull-spinning');
            return;
        }
        const dist = e.changedTouches[0].clientY - startY;
        if (dist >= THRESHOLD) {
            indicator.style.top = '12px';
            indicator.classList.add('pull-spinning');
            setTimeout(() => window.location.reload(), 300);
        } else {
            indicator.style.top = '-60px';
            indicator.classList.remove('pull-spinning');
        }
    }, { passive: true });
})();