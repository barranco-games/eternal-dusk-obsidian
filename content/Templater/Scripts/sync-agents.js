// Sincroniza Obsidian desde los archivos de Google Sheets de Eternal Dusk: las fichas de agentes
// y las notas generales de armas y consumibles.
// Sheets es la base de datos; este script se encarga de la presentación: resuelve los IDs
// (habilidades, equipo, pasivas, estados, tipos de daño) y reescribe las tablas de cada nota.
// Solo toca las secciones de las que la hoja tiene datos; el resto de la nota queda igual.
//
// Se usa igual desde Obsidian (Templater) y desde Node (al publicar con Quartz).

// IDs de los archivos: lo que va entre /d/ y /edit en la URL de cada uno.
// Deben estar compartidos como "Cualquier persona con el enlace: lector".
const ARCHIVOS = {
    agentes: "15PpBQu1Be2I08GWCfRiOPGdDmg6I6rO8kB8dDcyCk-8",
    habilidades: "1MNTW-syHtFnhblFw_mKcZxLOKvcbtLuV-NQTFWEuQHU",
    objetos: "1BdzhBaCZeJew4DqfjwT8PVIeVsz4Wjiz5tENGyErrkE",
    reglas: "1RWorzvol5UtFhx3RcZlzCZTR7ToR2O9W8TVERlrAozg",
};

// Pestaña de ED · Agentes -> carpeta de sus fichas.
const CARPETA_AGENTES = "03 - Entidades/Agentes";
const CARPETAS = { Party: "Party", Enemigos: "Enemigos", NPCs: "NPC" };

// Notas generales que se generan a partir de las hojas.
const NOTAS = {
    armas: "03 - Entidades/Armas/General.md",
    consumibles: "03 - Entidades/Consumibles/Objetos Consumibles.md",
    estados: "01 - Diseño/Mecánicas/Estados.md",
    areas: "01 - Diseño/Mecánicas/Áreas de Efectos.md",
    traumas: "01 - Diseño/Sistemas/Cordura/Traumas y Virtudes.md",
    posturas: "01 - Diseño/Sistemas/Agentes/Posturas.md",
};

// Pestañas que se leen de cada archivo para resolver IDs.
const PESTANAS = {
    agentes: Object.keys(CARPETAS),
    habilidades: ["Party", "Enemigos", "Comunes", "Armas", "Objetos", "Reacciones", "Pasivas", "Mejoras"],
    objetos: ["Armas", "Armaduras", "Trinkets", "Consumibles", "Municion", "Recursos"],
    reglas: ["Estadísticas", "Estados", "Tipos de daño", "Áreas de efecto", "Dados de Daño", "Posturas", "Traumas y Virtudes",
        "Modificadores", "Palabras clave"],
};

const STATS = ["CON", "FUE", "DES", "POD", "COG", "SUE"];
const DERIVADAS = ["HP", "MOV", "EVA", "COR", "PA"];
const SECCION_STAT = {
    CON: "Constitución", FUE: "Fuerza", DES: "Destreza", POD: "Poder", COG: "Cognición",
    SUE: "Suerte", HP: "Salud", MOV: "Movimiento", EVA: "Evasión", COR: "Cordura", PA: "PA",
};
const CARACTERISTICAS = [
    ["Descubrir", "^descubrir"], ["Rastrear", "^rastrear"], ["Sigilo", "^sigilo"],
    ["Ocultismo", "^ocultismo"], ["Lanzar", "^lanzar"], ["Subterfugio", "^subterfugio"],
    ["Medicina", "^medicina"], ["Perspicacia", "^perspicacia"], ["Intimidar", "^intimidar"],
    ["Persuadir", "^persuadir"], ["Engaño", "^enganio"],
];

const csvUrl = (archivo, pestana) =>
    `https://docs.google.com/spreadsheets/d/${ARCHIVOS[archivo]}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(pestana)}`;
const faltanIds = () => Object.values(ARCHIVOS).some((id) => id.startsWith("PEGAR"));

// Descarga todas las pestañas con la función `descargar(url)` de cada entorno.
// Devuelve { archivo: { pestaña: csv } }.
async function leerHojas(descargar) {
    const datos = {};
    await Promise.all(Object.entries(PESTANAS).flatMap(([archivo, pestanas]) => pestanas.map(async (p) => {
        (datos[archivo] ??= {})[p] = await descargar(csvUrl(archivo, p));
    })));
    return datos;
}

function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(cell); rows.push(row); row = []; cell = "";
        } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    const [header = [], ...data] = rows.filter((r) => r.some((c) => c.trim() !== ""));
    const claves = header.map((h) => ALIAS[h.trim()] ?? h.trim());
    return data.map((r) => Object.fromEntries(claves.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// Nombres de columna de las hojas -> nombre que usa el script.
const ALIAS = {
    "Bonificador Plano": "Bonificador",
    "Bonificador Estadísticas": "Bonificador de estadística",
    "Tipo de Daño (Bonificadores)": "Tipo de daño",
    "Hereda del Arma": "Hereda del arma",
    "Habilidad": "Habilidad de uso",
};

const lista = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------- Presentación ----------

// Dentro de una tabla de Markdown la barra de los enlaces [[nota|alias]] va escapada.
const celda = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const fila = (cs) => `| ${cs.join(" | ")} |`;
const enlaceStat = (seccion, texto) => `**[[Estadísticas de Agentes#${seccion}\\|${texto}]]**`;
const PA = "[[Estadísticas de Agentes#Puntos de Acciones\\|PA]]";
const COR = "[[Estadísticas de Agentes#Cordura\\|COR]]";
// En los daños, BD y BM se enlazan a su regla.
const conEnlaces = (t) => celda(t)
    .replace(/\bBD\b/g, "[[Armas#Bonificadores de Daño (BD)\\|BD]]")
    .replace(/\bBM\b/g, "[[Estadísticas de Agentes#^tabla-bm\\|BM]]");
const activa = (r) => r.ID && r.Nombre && r["Estado de diseño"] !== "Obsoleto";

function tablaEstadisticas(a) {
    const v = (k) => celda(a[k] || "-");
    const lineas = [
        fila(STATS.map((k) => enlaceStat(SECCION_STAT[k], k))),
        fila(STATS.map(() => ":---:")),
        fila(STATS.map(v)),
        fila([...DERIVADAS.map((k) => enlaceStat(SECCION_STAT[k], k)), ""]),
        fila([...DERIVADAS.map(v), ""]),
        "",
        fila(["**Característica**", "**Valor**"]),
        fila([":---", ":---:"]),
        ...CARACTERISTICAS.map(([k, s]) => fila([enlaceStat(s, k), celda(a[k] || "-")])),
    ];
    const res = Object.keys(a).filter((k) => k.startsWith("Res. "));
    if (res.some((k) => a[k] !== "")) {
        lineas.push("", fila(res.map((k) => `**${k.replace("Res. ", "Resistencia ")}**`)),
            fila(res.map(() => ":---:")), fila(res.map((k) => celda(a[k] || "-"))));
    }
    return lineas;
}

function textoRango(h) {
    const ef = h["Rango eficaz (m)"], max = h["Rango máximo (m)"];
    const metros = ef ? (max && max !== ef ? `${ef}m/${max}m` : `${ef}m`) : max ? `${max}m` : "";
    if (h["Clase de rango"] === "Melee") return ["[[Rangos y Áreas#Melee\\|Melee]]", metros].filter(Boolean).join("/");
    if (h["Clase de rango"] === "Lanzar") return "[[Estadísticas de Agentes#^tabla-lanzar\\|Lanzar]]";
    return metros;
}

function textoArea(h) {
    // El ángulo del cono puede venir ya con "º" en la hoja.
    const tipo = h["Tipo de área"], t1 = String(h["Tamaño 1"] ?? "").replace(/[º°]$/, ""), t2 = h["Tamaño 2"];
    if (!tipo) return "";
    const tam = tipo === "Línea" ? (t1 && t2 ? `${t1}m x ${t2}m` : "")
        : tipo === "Cono" ? [t1 && `${t1}º`, t2 && `${t2}m`].filter(Boolean).join(" ")
        : tipo === "Esfera" ? (t1 ? `${t1}m` : "") : "";
    return [`[[Rangos y Áreas#^tabla-areas\\|${tipo}]]`, tam].filter(Boolean).join(" ");
}

const coste = (h) => [h["Coste PA"] && `${h["Coste PA"]} ${PA}`, h["Coste Cordura"] && `${h["Coste Cordura"]} ${COR}`]
    .filter(Boolean).join(" + ");
// El daño se monta con Cantidad de dados, Tipo de dado, Bonificador y Bonificador de estadística
// (2D6 + 1 + BD). Si la fila aún tiene la columna "Daño" en texto, se usa tal cual.
function textoDanio(h) {
    if (h["Daño"]) return [h["Daño"], h["Suma BD"] === "Sí" && "BD"].filter(Boolean).join(" + ");
    const dado = String(h["Tipo de dado"] ?? "").trim().toUpperCase().replace(/^(\d)/, "D$1");
    const n = h["Cantidad de dados"];
    const fijo = h["Bonificador"] && Number(h["Bonificador"]) !== 0 ? h["Bonificador"] : "";
    const est = h["Bonificador de estadística"] || (h["Suma BD"] === "Sí" ? "BD" : "");
    return [dado && `${n || 1}${dado}`, fijo, est].filter(Boolean).join(" + ").replace(/\+ -/g, "- ");
}
const unDanio = (h, nombreDe) => [textoDanio(h), h["Tipo de daño"] && nombreDe(h["Tipo de daño"])].filter(Boolean).join(" ");
// Con la columna "Dados" (IDs de ED · Reglas › Dados de daño) se encadenan todos sus componentes:
// "1D6 + 2 Cortante + 1D6 Fuego". Los bonificadores de la fila se suman a los dados del tipo de daño
// de la fila (o al primero si no tiene); si ningún dado es de ese tipo, salen aparte con su tipo.
// Sin "Dados", se usan las columnas de daño de la propia fila.
let buscarDados = () => null;
const BONOS = ["Bonificador", "Bonificador de estadística", "Suma BD"];
const danio = (h, nombreDe) => {
    const dados = lista(h.Dados).map((id) => buscarDados(id) ?? { "Daño": id });
    if (!dados.length) return conEnlaces(unDanio(h, nombreDe));
    const bonos = Object.fromEntries(BONOS.map((k) => [k, h[k] ?? ""]));
    const tipo = h["Tipo de daño"];
    const i = tipo ? dados.findIndex((d) => d["Tipo de daño"] === tipo) : 0;
    const partes = dados.map((d, j) => (j === i ? { ...d, ...bonos } : d));
    if (i === -1) partes.push({ ...bonos, "Tipo de daño": tipo });
    return conEnlaces(partes.map((d) => unDanio(d, nombreDe)).filter(Boolean).join(" + "));
};

// Habilidades con "Hereda del arma" (o "Hereda del objeto") = Sí: daño, rango y área los pone el arma
// o el consumible que la usa (el ataque básico, una cura genérica...). Lo que el objeto deja vacío
// se queda como está en la habilidad.
const CAMPOS_ARMA = ["Daño", "Dados", "Cantidad de dados", "Tipo de dado", "Bonificador", "Bonificador de estadística",
    "Suma BD", "Tipo de daño", "Clase de rango", "Rango eficaz (m)", "Rango máximo (m)", "Tipo de área", "Tamaño 1", "Tamaño 2"];
const si = (v) => /^s[ií]$/i.test(String(v ?? "").trim());
const heredaDelArma = (h) => si(h["Hereda del arma"]) || si(h["Hereda del objeto"]);
const conDatosDeArma = (h, w) => {
    const propios = Object.fromEntries(CAMPOS_ARMA.filter((k) => w[k]).map((k) => [k, w[k]]));
    return { ...h, ...propios, ...(w.Clase ? { "Clase de rango": w.Clase } : {}) };
};

// `armaDe(h)`, si se pasa, añade la columna Arma detrás del nombre.
// `armaPara(h)`, si se pasa, da el arma de la que hereda una habilidad (en las fichas, la equipada).
function tablaHabilidades(habilidades, nombreDe, armaDe, armaPara) {
    const conArma = (cs) => (armaDe ? [cs[0], cs[1], ...cs.slice(2)] : [cs[0], ...cs.slice(2)]);
    return [
        fila(conArma(["**Nombre**", "**Arma**", "**Efecto**", "**Coste**", "**CD**", "**Daño**",
            "**[[Rangos y Áreas#Rangos\\|Rango]]**", "**[[Rangos y Áreas#Áreas de Daño\\|Objetivo]]**"])),
        fila(conArma(["---", ":---:", "---", ":---:", ":---:", ":---:", ":---:", ":---:"])),
        ...habilidades.map((h) => {
            const w = heredaDelArma(h) && armaPara?.(h);
            const d = w ? conDatosDeArma(h, w) : h;
            const segun = heredaDelArma(h) && !w ? "Según el arma" : null;
            return fila(conArma([
                `**${celda(h.Nombre)}**`, armaDe ? celda(armaDe(h) || "-") : "", celda(enlazar(h["Descripción"])), coste(h),
                celda(h["Enfriamiento (turnos)"]), segun ?? (danio(d, nombreDe) || "-"), segun ?? (textoRango(d) || "-"),
                segun ?? (textoArea(d) || "-"),
            ]));
        }),
    ];
}

// Las armas guardan su clase (Melee/Distancia) en "Clase de rango" (antes "Clase").
const rangoArma = (w) => textoRango({ ...w, "Clase de rango": w["Clase de rango"] || w.Clase });
const danioArma = danio;
const MANOS = { 1: "Una Mano", 2: "Dos Manos", Una: "Una Mano", Dos: "Dos Manos" };

function tablaArmas(armas, nombreDe) {
    return [
        fila(["**Arma**", "**Daño**", "**[[Rangos y Áreas#Rangos\\|Rango]]**", "**Objetivo**", "**Munición**",
            "**[[Armas#^armas-tipo\\|Tipo]]**", "**[[Armas#^tirada-fallo\\|Tirada de Fallo]]**", "**[[Armas#^manos\\|Manejo]]**"]),
        fila(["---", ":---:", ":---:", ":---:", ":---:", ":---:", ":---:", ":---:"]),
        ...armas.map((w) => fila([
            `**${celda(w.Nombre)}**`, danioArma(w, nombreDe), rangoArma(w) || "-", textoArea(w) || "-",
            celda([w.Cargador, w["Munición"] && `(${nombreDe(w["Munición"])})`].filter(Boolean).join(" ") || "-"),
            celda(w.Tipo || "-"), w["Tirada de fallo"] ? `${celda(w["Tirada de fallo"])}/000` : "-",
            MANOS[w.Manos] ?? celda(w.Manos || "-"),
        ])),
    ];
}

// Cada consumible toma coste, daño, rango y área de su habilidad de uso.
function tablaConsumibles(consumibles, buscar, nombreDe) {
    return [
        fila(["**Nombre**", "**Efecto**", "**Coste**", "**Daño**", "**[[Rangos y Áreas#Rangos\\|Rango]]**", "**Tipo**",
            "**[[Rangos y Áreas#Áreas de Daño\\|Área]]**"]),
        fila(["---", "---", ":---:", ":---:", ":---:", ":---:", ":---:"]),
        ...consumibles.map((c) => {
            const uso = (c["Habilidad de uso"] && buscar(c["Habilidad de uso"])) || {};
            const h = heredaDelArma(uso) ? conDatosDeArma(uso, c) : uso;
            return fila([
                `**${celda(c.Nombre)}**`, celda(enlazar((heredaDelArma(uso) && c["Descripción"]) || h["Descripción"] || c["Descripción"])), coste(h) || "-",
                danio(h, nombreDe) || "-", textoRango(h) || "-", h["Clase de rango"] === "Lanzar" ? "Lanzable" : "-",
                textoArea(h) || "-",
            ]);
        }),
    ];
}

function listaEquipo(a, buscar, nombreDe) {
    const arma = (id) => {
        const w = buscar(id);
        if (!w) return id;
        const datos = [danioArma(w, nombreDe), rangoArma(w)].filter(Boolean).join(", ");
        return datos ? `${w.Nombre} (${datos})` : w.Nombre;
    };
    const nombre = (id) => buscar(id)?.Nombre ?? id;
    return [
        a["Arma principal"] && `- **Arma principal:** ${arma(a["Arma principal"])}`,
        a["Arma secundaria"] && `- **Arma secundaria:** ${arma(a["Arma secundaria"])}`,
        a.Armadura && `- **Armadura:** ${nombre(a.Armadura)}`,
        lista(a.Trinkets).length && `- **Trinkets:** ${lista(a.Trinkets).map(nombre).join(", ")}` +
            (a["Huecos de trinket"] ? ` (${a["Huecos de trinket"]} huecos)` : ""),
    ].filter(Boolean);
}

// ---------- Reglas: estados, áreas, traumas y posturas ----------

// Los estados y las áreas son listas "- **Nombre:** descripción ^ancla". El ancla es su ID con guiones
// (sts_burning -> ^sts-burning; Obsidian no admite "_" en las anclas), así que renombrar no rompe enlaces.
// Si la nota tenía otra ancla para ese nombre (^quemado), los enlaces del vault que apuntaban a ella se
// cambian a la nueva en la misma pasada. Una columna "Ancla" en la hoja manda sobre el ID.
const slug = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const anclasDe = (texto) => new Map(String(texto ?? "").split("\n")
    .map((l) => l.match(/^- \*\*(.+?):\*\*.*\s\^([\w-]+)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const conAncla = (filas) => filas.map((r) => ({ ...r, _ancla: r.Ancla || (r.ID ? r.ID.replace(/_/g, "-") : slug(r.Nombre)) }));
const itemConAncla = (r) => `- **${r.Nombre}:** ${enlazar(r["Descripción"], r.Nombre)} ^${r._ancla}`;

// En las descripciones (que en la hoja son texto plano) se enlazan solos los estados, las áreas creadas
// ("área de Fuego"), las tiradas y las estadísticas, sacados de sus pestañas, más las palabras de
// ED · Reglas › Palabras clave (columnas Palabra y Enlace), para que en Obsidian salga su vista previa.
let enlazar = (t) => String(t ?? "");
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const L = "\\p{L}";
const palabra = (patron) => new RegExp(`(?<![${L}])(?:${patron})(?![${L}])`, "gu");
// "Envenenado" también enlaza "Envenenados", "Envenenada"...
const conFlexion = (n) => /o$/.test(n) ? `${escRe(n.slice(0, -1))}(?:o|a|os|as)` : `${escRe(n)}(?:s|es)?`;
const SECCION_POR_STAT = { "Puntos de Acción": "Puntos de Acciones" };
// Si no existe la pestaña Palabras clave, se usan estas.
const PALABRAS_CLAVE = [
    ["PA", "Estadísticas de Agentes#Puntos de Acciones"], ["Ventaja", "Dados#Ventaja y Desventaja"],
    ["Desventaja", "Dados#Ventaja y Desventaja"], ["Crítico", "Dados#Críticos"], ["Turno", "Turnos"],
];
// La primera letra vale en mayúscula o minúscula ("Ventaja" y "ventaja").
const inicioLibre = (p) => /^\p{L}/u.test(p) ? `[${p[0].toUpperCase()}${p[0].toLowerCase()}]${p.slice(1)}` : p;

function crearEnlazador({ estados, areas, stats, claves }) {
    const nombresStat = stats.filter((s) => ["Principal", "Secundaria"].includes(s.Grupo)).map((s) => s.Nombre);
    const reglas = [
        [palabra(`Tiradas?(?= de (?:${nombresStat.map(escRe).join("|")}))`), () => "Dados#Tiradas de Estadísticas"],
        // Las palabras clave van primero: así "Empujar Suerte" gana a la estadística Suerte.
        ...[...claves].sort((a, b) => b[0].length - a[0].length)
            .map(([p, enlace]) => [palabra(inicioLibre(conFlexion(p))), () => enlace, p]),
        ...areas.map((a) => [new RegExp(`(?<=área de )${escRe(a.Nombre)}(?![${L}])`, "giu"), () => `Áreas de Efectos#^${a._ancla}`, a.Nombre]),
        ...estados.map((e) => [palabra(conFlexion(e.Nombre)), () => `Estados#^${e._ancla}`, e.Nombre]),
        ...nombresStat.map((n) => [palabra(escRe(n)), () => `Estadísticas de Agentes#${SECCION_POR_STAT[n] ?? n}`]),
    ];
    // No se enlaza dentro de enlaces que ya existan ni un elemento dentro de su propia descripción.
    return (texto, propio) => reglas.reduce((t, [re, destino, nombre]) => (nombre && nombre === propio) ? t
        : t.split(/(\[\[[^\]]*\]\])/).map((trozo, i) => i % 2 ? trozo
            : trozo.replace(re, (m) => `[[${destino()}|${m}]]`)).join(""), String(texto ?? ""));
}

function listaEstados(lineas, estados) {
    const TITULOS = { Infligido: "Infligidos", Situacional: "Situacionales" };
    const categorias = [...new Set(estados.map((e) => e["Categoría"] || "Infligido"))];
    return categorias.reduce((ls, c) => reemplazarSeccion(ls, TITULOS[c] ?? c,
        estados.filter((e) => (e["Categoría"] || "Infligido") === c).map(itemConAncla), { modo: "lista" }), lineas);
}

// Traumas y virtudes: la columna Estadísticas sale de la descripción (o, si está vacía, de
// ED · Reglas › Modificadores) y la de Estados, del disparador, la probabilidad y el estado aplicado.
const DISPARADOR = { "Inicio de turno": "al inicio de su turno", "Fin de turno": "al acabar su turno" };
function tablaTraumas(filas, cabecera, modificadores, nombreDe) {
    const mod = (m) => {
        const v = String(m.Valor ?? "");
        const signo = m["Operación"] === "Multiplicador" ? "x" : /^[-+]/.test(v) ? "" : "+";
        return [`${signo}${v}${m["Operación"] === "Porcentaje" ? "%" : ""} ${nombreDe(m["Estadística"])}`,
            m["Condición"] && `(${m["Condición"]})`].filter(Boolean).join(" ");
    };
    return [
        fila([cabecera, "Estadísticas", "Estados"]),
        fila(["---", "---", "---"]),
        ...filas.map((t) => {
            const partes = String(t["Descripción"] ?? "").split(/;\s*|(?<=\.)\s+/).map((p) => p.trim().replace(/\.$/, "")).filter(Boolean);
            const stats = partes.filter((p) => !p.includes("%"));
            const efectos = partes.filter((p) => p.includes("%"));
            const mods = modificadores.filter((m) => m.Fuente === t.ID).map(mod);
            const estado = t["Estado aplicado"] && [t["Probabilidad (%)"] && `${t["Probabilidad (%)"]}% de obtener`,
                nombreDe(t["Estado aplicado"]), DISPARADOR[t.Disparador] ?? String(t.Disparador ?? "").toLowerCase()].filter(Boolean).join(" ");
            return fila([celda(t.Nombre), celda(enlazar((stats.length ? stats : mods).join("<br>"))),
                celda(enlazar([estado, ...efectos].filter(Boolean).join("<br>")))]);
        }),
    ];
}

// ---------- Edición de la nota ----------

const esBloque = (l) => l.startsWith("|") || l.startsWith("```");
const esItem = (l) => /^\s*- /.test(l);

// Sustituye en la sección "# <titulo>" o bien sus tablas (modo "tablas", el texto de alrededor se
// queda), su lista (modo "lista", igual pero con la lista) o bien todo su cuerpo (modo "todo").
// Si la sección no existe, la crea antes de `antesDe`.
function reemplazarSeccion(lineas, titulo, nuevas, { modo = "tablas", antesDe } = {}) {
    const ini = lineas.findIndex((l) => l.trim() === `# ${titulo}`);
    if (ini === -1) {
        const pos = antesDe ? lineas.findIndex((l) => l.trim() === `# ${antesDe}`) : -1;
        const bloque = [`# ${titulo}`, ...nuevas];
        return pos === -1 ? [...lineas, ...bloque] : [...lineas.slice(0, pos), ...bloque, ...lineas.slice(pos)];
    }
    let fin = lineas.findIndex((l, i) => i > ini && /^# /.test(l));
    if (fin === -1) fin = lineas.length;
    const cuerpo = lineas.slice(ini + 1, fin);
    let nuevoCuerpo;
    if (modo === "todo") {
        let k = cuerpo.length;
        while (k > 0 && cuerpo[k - 1].trim() === "") k--;
        nuevoCuerpo = [...nuevas, ...cuerpo.slice(k)];
    } else {
        const bloque = modo === "lista" ? esItem : esBloque;
        const a = cuerpo.findIndex(bloque);
        const b = cuerpo.length - 1 - [...cuerpo].reverse().findIndex(bloque);
        nuevoCuerpo = a === -1 ? [...nuevas, ...cuerpo] : [...cuerpo.slice(0, a), ...nuevas, ...cuerpo.slice(b + 1)];
    }
    return [...lineas.slice(0, ini + 1), ...nuevoCuerpo, ...lineas.slice(fin)];
}

// Sustituye la primera tabla (o lista, con esItem) de la nota, para notas que no tienen secciones.
function reemplazarPrimeraTabla(lineas, nuevas, esParte = (l) => l.startsWith("|")) {
    const a = lineas.findIndex(esParte);
    if (a === -1) return [...nuevas, "", ...lineas];
    let b = a;
    while (b + 1 < lineas.length && esParte(lineas[b + 1])) b++;
    return [...lineas.slice(0, a), ...nuevas, ...lineas.slice(b + 1)];
}

// ---------- Núcleo común ----------

async function sincronizar({ datos, leer, escribir, listar, log }) {
    // Índice de todo lo que se puede referenciar por ID.
    const indice = new Map();
    for (const archivo of ["habilidades", "objetos", "reglas"]) {
        for (const [pestana, csv] of Object.entries(datos[archivo] ?? {})) {
            for (const r of parseCSV(csv)) if (r.ID) indice.set(r.ID, { ...r, _pestana: pestana });
        }
    }
    const faltan = new Set();
    const buscar = (id) => { const r = indice.get(id); if (!r) faltan.add(id); return r; };
    const nombreDe = (id) => buscar(id)?.Nombre ?? id;
    buscarDados = buscar;

    // Estados y áreas, con sus anclas, para generar sus notas y enlazar las descripciones.
    const reglas = (p) => parseCSV(datos.reglas?.[p] ?? "").filter(activa);
    const notaEstados = await leer(NOTAS.estados), notaAreas = await leer(NOTAS.areas);
    const estados = conAncla(reglas("Estados"));
    const areas = conAncla(reglas("Áreas de efecto").filter((r) => r["Descripción"]));
    const claves = parseCSV(datos.reglas?.["Palabras clave"] ?? "").filter((r) => r.Palabra && r.Enlace)
        .map((r) => [r.Palabra, r.Enlace]);
    enlazar = crearEnlazador({ estados, areas, stats: reglas("Estadísticas"), claves: claves.length ? claves : PALABRAS_CLAVE });
    // Anclas antiguas de la nota: las que cambian se migran en todo el vault; las que se quedan sin
    // elemento (un estado borrado u obsoleto) se avisan.
    const cambiosDeAncla = [], anclasPerdidas = [];
    const revisarAnclas = (previas, filas, nota) => {
        for (const [nombre, a] of previas) {
            const r = filas.find((f) => f.Nombre === nombre);
            if (r && r._ancla !== a) cambiosDeAncla.push({ nota, de: a, a: r._ancla });
            else if (!r && !filas.some((f) => f._ancla === a)) anclasPerdidas.push(`${nota}#^${a}`);
        }
    };
    if (estados.length) revisarAnclas(anclasDe(notaEstados), estados, "Estados");
    if (areas.length) revisarAnclas(anclasDe(notaAreas), areas, "Áreas de Efectos");

    const resumen = { actualizadas: [], sinCambios: [], noEncontradas: [], idsDesconocidos: [] };
    for (const [pestana, carpeta] of Object.entries(CARPETAS)) {
        for (const a of parseCSV(datos.agentes?.[pestana] ?? "")) {
            if (!a.ID || !a.Nombre) continue;
            const ruta = `${CARPETA_AGENTES}/${carpeta}/${a.Nombre}.md`;
            const actual = await leer(ruta);
            if (actual == null) { resumen.noEncontradas.push(ruta); continue; }

            let lineas = actual.split("\n");
            if (STATS.some((k) => a[k] !== "")) lineas = reemplazarSeccion(lineas, "Estadísticas", tablaEstadisticas(a));
            const equipo = listaEquipo(a, buscar, nombreDe);
            if (equipo.length) lineas = reemplazarSeccion(lineas, "Equipo", equipo, { modo: "todo", antesDe: "Habilidades" });
            const pasivas = lista(a.Pasivas).map(buscar).filter(Boolean);
            if (pasivas.length) lineas = reemplazarSeccion(lineas, "Atributos",
                pasivas.map((p) => `- **${p.Nombre}:** ${enlazar(p["Descripción"])}`.trimEnd()), { modo: "todo", antesDe: "Habilidades" });
            const habilidades = lista(a.Habilidades).map(buscar).filter(Boolean);
            const equipadas = [a["Arma principal"], a["Arma secundaria"]].filter(Boolean).map(buscar).filter(Boolean);
            const armaPara = (h) => equipadas.find((w) => w["Ataque básico"] === h.ID || lista(w.Habilidades).includes(h.ID))
                ?? equipadas[0];
            if (habilidades.length) lineas = reemplazarSeccion(lineas, "Habilidades", tablaHabilidades(habilidades, nombreDe, null, armaPara));

            const nuevo = lineas.join("\n");
            if (nuevo === actual) { resumen.sinCambios.push(a.Nombre); continue; }
            await escribir(ruta, nuevo);
            resumen.actualizadas.push(a.Nombre);
        }
    }
    // Notas generales: solo se reescriben si su pestaña tiene filas.
    const filas = (archivo, pestana) => parseCSV(datos[archivo]?.[pestana] ?? "").filter(activa);
    const generales = {
        armas: (lineas) => {
            const armas = filas("objetos", "Armas");
            const habilidades = filas("habilidades", "Armas");
            if (armas.length) lineas = reemplazarSeccion(lineas, "Tabla de Armas", tablaArmas(armas, nombreDe));
            if (habilidades.length) {
                const armaDe = (h) => armas.filter((w) => lista(w.Habilidades).includes(h.ID) || w["Ataque básico"] === h.ID)
                    .map((w) => w.Nombre).join(", ");
                lineas = reemplazarSeccion(lineas, "Habilidades de Armas", tablaHabilidades(habilidades, nombreDe, armaDe));
            }
            return lineas;
        },
        consumibles: (lineas) => {
            const consumibles = filas("objetos", "Consumibles");
            return consumibles.length ? reemplazarPrimeraTabla(lineas, tablaConsumibles(consumibles, buscar, nombreDe)) : lineas;
        },
        estados: (lineas) => {
            return estados.length ? listaEstados(lineas, estados) : lineas;
        },
        areas: (lineas) => {
            return areas.length ? reemplazarPrimeraTabla(lineas, areas.map(itemConAncla), (l) => /^- \*\*/.test(l)) : lineas;
        },
        traumas: (lineas) => {
            const filas = reglas("Traumas y Virtudes"), mods = reglas("Modificadores").filter((m) => m.Fuente);
            const traumas = filas.filter((t) => t.Tipo === "Trauma"), virtudes = filas.filter((t) => t.Tipo === "Virtud");
            if (traumas.length) lineas = reemplazarSeccion(lineas, "Traumas Básicos", tablaTraumas(traumas, "Aflicción", mods, nombreDe));
            if (virtudes.length) lineas = reemplazarSeccion(lineas, "Virtudes", tablaTraumas(virtudes, "Virtud", mods, nombreDe));
            return lineas;
        },
        posturas: (lineas) => reglas("Posturas").reduce((ls, p) =>
            reemplazarSeccion(ls, p.Nombre, [`- ${enlazar(p["Descripción"], p.Nombre)}`], { modo: "todo" }), lineas),
    };
    for (const [clave, generar] of Object.entries(generales)) {
        const ruta = NOTAS[clave];
        const actual = await leer(ruta);
        if (actual == null) { resumen.noEncontradas.push(ruta); continue; }
        const nuevo = generar(actual.split("\n")).join("\n");
        if (nuevo === actual) continue;
        await escribir(ruta, nuevo);
        resumen.actualizadas.push(ruta.split("/").pop().replace(/\.md$/, ""));
    }

    // Enlaces a anclas antiguas (Estados#^quemado -> Estados#^sts-burning) en todas las notas.
    const migradas = [];
    if (cambiosDeAncla.length && listar) {
        const patrones = cambiosDeAncla.map((c) =>
            [new RegExp(`((?:\\[\\[|/)${escRe(c.nota)})#\\^${escRe(c.de)}(?![\\w-])`, "g"), `$1#^${c.a}`]);
        for (const ruta of await listar()) {
            const actual = await leer(ruta);
            if (actual == null) continue;
            const nuevo = patrones.reduce((t, [re, por]) => t.replace(re, por), actual);
            if (nuevo !== actual) { await escribir(ruta, nuevo); migradas.push(ruta.split("/").pop().replace(/\.md$/, "")); }
        }
    }

    resumen.idsDesconocidos = [...faltan];
    log(`Notas actualizadas: ${resumen.actualizadas.length ? resumen.actualizadas.join(", ") : "ninguna"}` +
        (resumen.noEncontradas.length ? `. Notas no encontradas: ${resumen.noEncontradas.join(", ")}` : "") +
        (faltan.size ? `. IDs que no existen en las hojas: ${[...faltan].join(", ")}` : "") +
        (migradas.length ? `. Enlaces cambiados a las anclas nuevas en: ${migradas.join(", ")}` : "") +
        (cambiosDeAncla.length && !listar ? ". Hay anclas nuevas pero no se han podido migrar los enlaces" : "") +
        (anclasPerdidas.length ? `. Anclas que ya no existen (revisa sus enlaces): ${anclasPerdidas.join(", ")}` : ""));
    return resumen;
}

// Entrada de Templater: tp.user["sync-agents"](tp). También sirve como user script de QuickAdd.
// La API de Obsidian llega en tp.obsidian (o params.obsidian en QuickAdd): require("obsidian")
// no funciona dentro de los user scripts.
module.exports = async (ctx = {}) => {
    if (!ctx.obsidian) throw new Error('sync-agents: llámalo pasándole tp, así: tp.user["sync-agents"](tp)');
    const { requestUrl, Notice, TFile } = ctx.obsidian;
    const vault = (ctx.app ?? app).vault;
    if (faltanIds()) { new Notice("sync-agents: faltan los IDs de los archivos de Sheets"); return ""; }
    let datos;
    try {
        datos = await leerHojas(async (url) => (await requestUrl({ url })).text);
    } catch (e) {
        new Notice(`sync-agents: no se pudieron leer las hojas (${e.message ?? e}). ¿Están compartidas con enlace?`, 15000);
        return "";
    }
    try {
        // El vault puede ser la carpeta content/ o la raíz del repo de Quartz.
        const archivo = (ruta) => [ruta, `content/${ruta}`]
            .map((r) => vault.getAbstractFileByPath(r)).find((f) => f instanceof TFile);
        await sincronizar({
            datos,
            leer: async (ruta) => { const f = archivo(ruta); return f ? vault.read(f) : null; },
            escribir: (ruta, texto) => vault.modify(archivo(ruta), texto),
            listar: async () => vault.getMarkdownFiles().map((f) => f.path),
            log: (m) => new Notice(m, 15000),
        });
    } catch (e) {
        console.error(e);
        new Notice(`sync-agents: error al escribir las fichas (${e.message ?? e})`, 15000);
    }
    return "";
};
module.exports.sincronizar = sincronizar;
module.exports.leerHojas = leerHojas;
module.exports.faltanIds = faltanIds;
module.exports.PESTANAS = PESTANAS;
