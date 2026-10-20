// Sincroniza las fichas de agentes desde Google Sheets antes de publicar con Quartz.
// Usa el mismo código que el comando de Obsidian (content/Templater/Scripts/sync-agents.js).
//
//   node scripts/sync-agents.mjs              lee los archivos de Google Sheets
//   node scripts/sync-agents.mjs --csv <dir>  lee <dir>/<archivo>/<pestaña>.csv (archivo = agentes, habilidades, objetos, reglas)
import { createRequire } from "node:module"
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import path from "node:path"

const require = createRequire(import.meta.url)
const contentDir = path.resolve(process.env.CONTENT_DIR ?? "content")
const sync = require(path.join(contentDir, "Templater/Scripts/sync-agents.js"))

const csvArg = process.argv.indexOf("--csv")
let datos
if (csvArg !== -1) {
  const dir = process.argv[csvArg + 1]
  datos = {}
  for (const [archivo, pestanas] of Object.entries(sync.PESTANAS)) {
    datos[archivo] = {}
    for (const p of pestanas) {
      datos[archivo][p] = await readFile(path.join(dir, archivo, `${p}.csv`), "utf8").catch(() => "")
    }
  }
} else {
  if (sync.faltanIds()) throw new Error("faltan los IDs de los archivos de Sheets en sync-agents.js")
  datos = await sync.leerHojas(async (url) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`no se pudo leer ${url} (HTTP ${res.status})`)
    return res.text()
  })
}

const resumen = await sync.sincronizar({
  datos,
  leer: (ruta) => readFile(path.join(contentDir, ruta), "utf8").catch(() => null),
  escribir: (ruta, texto) => writeFile(path.join(contentDir, ruta), texto),
  crear: async (ruta, texto) => {
    await mkdir(path.dirname(path.join(contentDir, ruta)), { recursive: true })
    await writeFile(path.join(contentDir, ruta), texto)
  },
  listar: async () => (await readdir(contentDir, { recursive: true })).filter((f) => f.endsWith(".md")).map((f) => f.split(path.sep).join("/")),
  log: console.log,
})
if (resumen.noEncontradas.length || resumen.idsDesconocidos.length) process.exitCode = 1
