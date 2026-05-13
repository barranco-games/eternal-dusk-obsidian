module.exports = async () => {
    const file = app.workspace.getActiveFile();
    if (!file) return;

    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    if (!fm) return;

    // -----------------------
    // BASE STATS
    // -----------------------
    const CON = fm.CON ?? 0;
    const FUE = fm.FUE ?? 0;
    const DES = fm.DES ?? 0;
    const POD = fm.POD ?? 0;
    const COG = fm.COG ?? 0;

    // -----------------------
    // DERIVED STATS
    // -----------------------
    const total = COG + POD;

    const PA =
        total <= 64 ? 4 :
        total <= 84 ? 5 :
        total <= 124 ? 6 :
        total <= 164 ? 7 : 8;

    const MOV =
        (DES < CON && FUE < CON) ? 7 :
        (DES > CON && FUE > CON) ? 9 :
        8;

    const HP = Math.floor(CON / 4);
    const EVA = Math.ceil(DES / 2);
    const COR = POD;

    // -----------------------
    // LINK using obsidian URI (pipe-safe)
    // -----------------------
    const link = (section, label) =>
        `<a data-href="Estadísticas de Agentes#${section}" href="Estadísticas de Agentes#${section}" class="internal-link" target="_blank" rel="noopener">${label}</a>`;

    // -----------------------
    // HTML TABLE (pipe-safe)
    // -----------------------
    const table = `
<table>
<thead>
<tr>
  <th>${link("Constitución","CON")}</th>
  <th>${link("Fuerza","FUE")}</th>
  <th>${link("Destreza","DES")}</th>
  <th>${link("Poder","POD")}</th>
  <th>${link("Cognición","COG")}</th>
</tr>
</thead>
<tbody>
<tr>
  <td>${CON}</td>
  <td>${FUE}</td>
  <td>${DES}</td>
  <td>${POD}</td>
  <td>${COG}</td>
</tr>
<tr>
  <th>${link("Salud","HP")}</th>
  <th>${link("Evasión","EVA")}</th>
  <th>${link("Movimiento","MOV")}</th>
  <th>${link("PA","PA")}</th>
  <th>${link("Cordura","COR")}</th>
</tr>
<tr>
  <td>${HP}</td>
  <td>${EVA}</td>
  <td>${MOV}</td>
  <td>${PA}</td>
  <td>${COR}</td>
</tr>
</tbody>
</table>`;

    // -----------------------
    // INSERT INTO NOTE
    // -----------------------
    const newContent = content.replace(
        /<!--STATS-START-->[\s\S]*?<!--STATS-END-->/,
        `<!--STATS-START-->\n${table}\n<!--STATS-END-->`
    );

    await app.vault.modify(file, newContent);
};