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
                setTimeout(() => { banner.style.display = 'none'; }, 7000);
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
let dificultadesUnicas = []; // lista de niveles de dificultad distintos (D1, D2, ...), ordenada

// Filtros activos de los 4 desplegables. null = "cualquiera" (sin filtrar esa dimensión).
let filterFigura = null;
let filterPosIni = null;
let filterPosFin = null;
let filterDificultad = null;

// Muchas figuras son "compuestas" (ej. "Gancho + Traslado": son dos
// movimientos hechos seguidos). Para que el filtro de Figura las encuentre
// también al buscar por cada movimiento individual, y para poder elegir
// "Gancho" aunque no exista ninguna toma que sea SÓLO "Gancho", se
// descompone cada figura en las partes separadas por "+".
function componentesDeFigura(figuraStr) {
    if (!figuraStr) return [figuraStr]; // "" (sin nombre propio) es un valor válido en sí mismo
    return figuraStr.split('+').map(s => s.trim()).filter(Boolean);
}

// Un combo "coincide" con un valor de filtro de Figura si ese valor es
// exactamente su figura completa (compuesta o no, permite elegir
// "Gancho + Traslado" a propósito) O si es uno de los movimientos
// individuales que la componen (permite que "Gancho" o "Traslado" por
// separado también encuentren esta toma compuesta).
function comboCoincideFigura(combo, valor) {
    if (combo.figura === valor) return true;
    return componentesDeFigura(combo.figura).includes(valor);
}

// Devuelve los combos que cumplen los filtros activos, opcionalmente ignorando
// una dimensión (para calcular las OPCIONES de esa misma dimensión sin que se
// autofiltre a sí misma).
function combosFiltrados(excluirDimension) {
    return combosData.filter(c => {
        if (excluirDimension !== 'figura' && filterFigura !== null && !comboCoincideFigura(c, filterFigura)) return false;
        if (excluirDimension !== 'posIni' && filterPosIni !== null && c.posIni !== filterPosIni) return false;
        if (excluirDimension !== 'posFin' && filterPosFin !== null && c.posFin !== filterPosFin) return false;
        if (excluirDimension !== 'dificultad' && filterDificultad !== null && !(c.dificultades && c.dificultades[filterDificultad] && c.dificultades[filterDificultad].length)) return false;
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
    const set = new Set();
    candidatos.forEach(c => {
        Object.keys(c.dificultades || {}).forEach(d => {
            if (c.dificultades[d] && c.dificultades[d].length) set.add(d);
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
        candidatos = combosData.slice();
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

// Actualiza el texto de los 3 desplegables. Si una dimensión no tiene filtro propio
// pero todos los combos candidatos comparten el mismo valor, se muestra igual
// (autocompletado visual); si no, se muestra el placeholder de "sin elegir".
function actualizarEtiquetasFiltros(candidatos) {
    if (!candidatos) candidatos = combosFiltrados(null);
    const valorUnico = (campo) => {
        const set = new Set(candidatos.map(c => c[campo]).filter(Boolean));
        return set.size === 1 ? [...set][0] : null;
    };

    const figEl = document.getElementById('fig-selected');
    // El label de Figura sólo muestra un nombre si el usuario lo eligió
    // explícitamente (filterFigura !== null). Antes se "autocompletaba" con
    // valorUnico('figura') cuando, al filtrar por Posición Inicial/Final,
    // sólo quedaba una figura posible: eso hacía que "Cualquier Figura"
    // desapareciera solo. Ahora se mantiene en "Cualquier Figura" hasta que
    // el usuario la elija a propósito. filterFigura === "" es una selección
    // real y explícita (las figuras "sin nombre"), se muestra como "---".
    if (filterFigura === null) {
        figEl.innerHTML = `💃 Cualquier Figura [🌈]`;
    } else {
        figEl.innerHTML = `💃 ${filterFigura === '' ? '---' : filterFigura}`;
    }

    const posIniEl = document.getElementById('posini-selected');
    posIniEl.innerHTML = (filterPosIni === null)
        ? `<span class="pos-dot pos-dot-ini"></span>Cualquier Posición Inicial [🌈]`
        : `<span class="pos-dot pos-dot-ini"></span>${filterPosIni === '' ? '---' : filterPosIni}`;

    const posFinEl = document.getElementById('posfin-selected');
    posFinEl.innerHTML = (filterPosFin === null)
        ? `<span class="pos-dot pos-dot-fin"></span>Cualquier Posición Final [🌈]`
        : `<span class="pos-dot pos-dot-fin"></span>${filterPosFin === '' ? '---' : filterPosFin}`;
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
    document.getElementById('song-selected').innerText = `🎧 ${primera.name} [${primera.bpm} BPM]`;
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
    const pasosActuales = construirPasosFiltrados();
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
        label.innerText = `Movimiento ${numeroMovimiento}`;
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
        dificultadBadge.className = 'info-badge info-badge-dificultad';
        dificultadBadge.innerText = mostrarValor(niv);
        centerOverlay.appendChild(dificultadBadge);

        const posIniBadge = document.createElement('div');
        posIniBadge.className = 'info-badge info-badge-posini';
        posIniBadge.innerText = mostrarValor(comboActual.posIni);
        centerOverlay.appendChild(posIniBadge);

        const figuraBadge = document.createElement('div');
        figuraBadge.className = 'info-badge info-badge-figura';
        figuraBadge.innerText = mostrarValor(comboActual.figura);
        centerOverlay.appendChild(figuraBadge);

        const posFinBadge = document.createElement('div');
        posFinBadge.className = 'info-badge info-badge-posfin';
        posFinBadge.innerText = mostrarValor(comboActual.posFin);
        centerOverlay.appendChild(posFinBadge);

        cell.appendChild(centerOverlay);

        // Cartel opcional (toggle "T"): número inicial - 3 letras finales
        // del archivo de video actual, pegado abajo de todo en el video.
        if (mostrarTitulo) {
            const infoArchivo = extraerInfoArchivo(item.file8t);
            if (infoArchivo) {
                const tituloOverlay = document.createElement('div');
                tituloOverlay.className = 'titulo-bottom-overlay';
                const tituloBadge = document.createElement('div');
                tituloBadge.className = 'info-badge info-badge-titulo';
                tituloBadge.innerText = `${infoArchivo.numero} - ${infoArchivo.letras}`;
                tituloOverlay.appendChild(tituloBadge);
                cell.appendChild(tituloOverlay);
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
    const valores = [...valorSet]
        .filter(f => etiquetaFigura(f).toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => etiquetaFigura(a).localeCompare(etiquetaFigura(b)));

    // El ítem "Cualquier Figura" usa data-any="1" (en vez de data-value="")
    // para no confundirse con la figura real de valor "" (las que en el
    // nombre de archivo llevan "---" y se muestran acá también como "---").
    let html = `<div class="dropdown-item ${filterFigura === null ? 'selected' : ''}" data-any="1">💃 Cualquier Figura [🌈]</div>`;
    if (valores.length > 0) {
        html += valores.map(f => `
            <div class="dropdown-item ${f === filterFigura ? 'selected' : ''}" data-value="${f}">
                💃 ${etiquetaFigura(f)}
            </div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item').forEach(item => {
        item.onclick = () => {
            filterFigura = item.dataset.any === '1' ? null : item.dataset.value;
            ultimaDimensionSeleccionada = 'figura';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
        };
    });
}

function renderPosIniList(searchTerm = "") {
    const listEl = document.getElementById('posini-list');
    const candidatos = combosFiltrados('posIni');
    const etiquetaPos = (p) => (p === '' ? '---' : p);
    const valores = [...new Set(candidatos.map(c => c.posIni).filter(v => typeof v === 'string'))]
        .filter(p => etiquetaPos(p).toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => etiquetaPos(a).localeCompare(etiquetaPos(b)));

    // "Cualquier Posición Inicial" usa data-any="1" (en vez de data-value="")
    // para no confundirse con la posición real de valor "" (las que se
    // muestran acá como "---").
    let html = `<div class="dropdown-item ${filterPosIni === null ? 'selected' : ''}" data-any="1"><span class="pos-dot pos-dot-ini"></span>Cualquier Posición Inicial [🌈]</div>`;
    if (valores.length > 0) {
        html += valores.map(p => `
            <div class="dropdown-item ${p === filterPosIni ? 'selected' : ''}" data-value="${p}"><span class="pos-dot pos-dot-ini"></span>${etiquetaPos(p)}</div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item').forEach(item => {
        item.onclick = () => {
            filterPosIni = item.dataset.any === '1' ? null : item.dataset.value;
            ultimaDimensionSeleccionada = 'posIni';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
        };
    });
}

function renderPosFinList(searchTerm = "") {
    const listEl = document.getElementById('posfin-list');
    const candidatos = combosFiltrados('posFin');
    const etiquetaPos = (p) => (p === '' ? '---' : p);
    const valores = [...new Set(candidatos.map(c => c.posFin).filter(v => typeof v === 'string'))]
        .filter(p => etiquetaPos(p).toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => etiquetaPos(a).localeCompare(etiquetaPos(b)));

    let html = `<div class="dropdown-item ${filterPosFin === null ? 'selected' : ''}" data-any="1"><span class="pos-dot pos-dot-fin"></span>Cualquier Posición Final [🌈]</div>`;
    if (valores.length > 0) {
        html += valores.map(p => `
            <div class="dropdown-item ${p === filterPosFin ? 'selected' : ''}" data-value="${p}"><span class="pos-dot pos-dot-fin"></span>${etiquetaPos(p)}</div>
        `).join('');
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.dropdown-item').forEach(item => {
        item.onclick = () => {
            filterPosFin = item.dataset.any === '1' ? null : item.dataset.value;
            ultimaDimensionSeleccionada = 'posFin';
            closeAllDropdowns();
            recalcularComboActual();
            aplicarCambioVisual();
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
            document.getElementById('song-selected').innerText = item.innerText;
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
        };
    });
}

function closeAllDropdowns() {
    document.getElementById('fig-options-panel').style.display = 'none';
    document.getElementById('song-options-panel').style.display = 'none';
    document.getElementById('ver-options-panel').style.display = 'none';
    document.getElementById('posini-options-panel').style.display = 'none';
    document.getElementById('posfin-options-panel').style.display = 'none';
    document.getElementById('menu-options-panel').style.display = 'none';
}

// Si el panel pasado ya estaba abierto, clickear su mismo botón lo cierra
// (igual que clickear afuera), en vez de volver a abrirlo.
function toggleDropdown(panelId, openFn) {
    const panel = document.getElementById(panelId);
    const yaEstabaAbierto = panel.style.display === 'flex';
    closeAllDropdowns();
    if (!yaEstabaAbierto) {
        panel.style.display = 'flex';
        if (openFn) openFn();
    }
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
    if (filterFigura === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterFigura = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
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
};
document.getElementById('posini-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'posIni';
    if (filterPosIni === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosIni = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
};
document.getElementById('posfin-reset-btn').onclick = (e) => {
    e.stopPropagation();
    ultimaDimensionSeleccionada = 'posFin';
    if (filterPosFin === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();
    filterPosFin = null;
    closeAllDropdowns();
    recalcularComboActual();
    aplicarCambioVisual();
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
    if (filterFigura === null && filterDificultad === null && filterPosIni === null && filterPosFin === null) return;
    if (isPlaying || !isFirstAction) mutearParaCarga();

    filterFigura = null;
    filterDificultad = null;
    filterPosIni = null;
    filterPosFin = null;

    recalcularComboActual();
    aplicarCambioVisual();

    // Si algún desplegable está abierto, refrescar su resaltado también.
    renderFigureList(document.getElementById('fig-search').value);
    renderDificultadList();
    renderPosIniList(document.getElementById('posini-search').value);
    renderPosFinList(document.getElementById('posfin-search').value);
}

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
        document.getElementById('song-selected').innerText = `🎧 ${sortedSongs[newIndex].name} [${sortedSongs[newIndex].bpm} BPM]`;
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
        document.getElementById('song-selected').innerText = `🎧 ${songObj.name} [${songObj.bpm} BPM]`;
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
    if (!fig || !figurasData[fig]) return;
    const niveles = Object.keys(figurasData[fig]);
    if (niveles.length === 0) return;

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
    const el = document.getElementById('ver-selected');
    el.innerText = filterDificultad !== null
        ? currentDificultadValue
        : `🌈`;
}

// Arma la lista plana de TODAS las tomas (combinación + dificultad + variante)
// que cumplen los filtros activos. Cada Dificultad y cada variante dentro de
// una misma Dificultad (V2, V3, etc.) cuenta como un paso propio, así el total
// coincide con la cantidad real de videos subidos (p.ej. 101), no con la
// cantidad de combinaciones únicas de Posición/Figura/Posición (74).
function construirPasosFiltrados() {
    const candidatos = combosFiltrados(null).slice().sort(compararCombos);
    const pasos = [];
    candidatos.forEach(combo => {
        const dificultades = combo.dificultades || {};
        Object.keys(dificultades)
            .sort((a, b) => parseInt(a.replace('D', '')) - parseInt(b.replace('D', '')))
            .forEach(dif => {
                if (filterDificultad !== null && dif !== filterDificultad) return;
                const tomas = dificultades[dif] || [];
                tomas.forEach((_, variantIndex) => {
                    pasos.push({ comboId: combo.id, dificultad: dif, variantIndex });
                });
            });
    });
    return pasos;
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
    // No pisar lo que el usuario está tecleando mientras tiene el foco ahí.
    if (pageInputEl && document.activeElement !== pageInputEl) {
        pageInputEl.value = total === 0 ? 0 : idx + 1;
    }
    if (pageInputEl) {
        pageInputEl.max = total || 1;
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
}

prevPageBtn.onclick = () => moverCombo(-1);

nextPageBtn.onclick = () => moverCombo(1);

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
    const totalVideos = mainVideos.length;

    const loadingCount = loadingIndicator.querySelector('.loading-count');
    loadingIndicator.style.display = 'flex';
    if (loadingCount) loadingCount.textContent = `0 / ${totalVideos}`;

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
        let readyCount = 0;
        const waitCanPlay = mainVideos.map(v => new Promise(resolve => {
            if (v.readyState >= 3) { resolve(); return; }
            const fn = () => { v.removeEventListener('canplaythrough', fn); resolve(); };
            v.addEventListener('canplaythrough', fn);
            setTimeout(resolve, 12000); // fallback 12s
        }).then(() => {
            readyCount++;
            if (loadingCount) loadingCount.textContent = `${readyCount} / ${totalVideos}`;
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

        await Promise.all(mainVideos.map(v => v.play()));
        if (currentSeq !== loadSequence) {
            mainVideos.forEach(v => v.pause());
            return;
        }
        await audioPlayer.play();
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
        playIcon.innerHTML = "■";
        playIcon.className = "icon-stop";
    } else {
        playBtn.className = isFirstAction ? "btn-yellow" : "btn-green";
        playIcon.innerHTML = "▶";
        playIcon.className = "icon-play";
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
    toggleDropdown('menu-options-panel');
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
    const isRateInput = e.target.id === 'rate-input';
    const isOtherInput = e.target.tagName.toLowerCase() === 'input' && !isRateInput;
    if (isOtherInput) return;

    const hotkeys = [' ', 's', 'r', 'm', 't', '+', '-', 'a', 'd', 'q', 'e', 'w', 'f', '0', '1', '2', '3', '4', '5', '|', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];
    if (isRateInput && hotkeys.includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.target.blur();
    }

    switch(e.key.toLowerCase()) {
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

    let startY = 0;
    let pulling = false;

    document.addEventListener('touchstart', (e) => {
        if (window.scrollY === 0 && e.touches.length === 1) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!pulling) return;
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
        const dist = e.changedTouches[0].clientY - startY;
        if (dist >= THRESHOLD) {
            indicator.style.top = '12px';
            indicator.classList.add('pull-spinning');
            setTimeout(() => window.location.reload(), 300);
        } else {
            indicator.style.top = '-60px';
            indicator.classList.remove('pull-spinning');
        }
        pulling = false;
    }, { passive: true });
})();