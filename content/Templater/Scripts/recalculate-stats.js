module.exports = async () => {
    const file = app.workspace.getActiveFile();
    if (!file) return;

    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    if (!fm) return;

    const CON = fm.CON ?? 0;
    const FUE = fm.FUE ?? 0;
    const DES = fm.DES ?? 0;
    const POD = fm.POD ?? 0;
    const COG = fm.COG ?? 0;

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

    const link = (section, label) =>
        `<a data-href="Estadísticas de Agentes#${section}" href="Estadísticas de Agentes#${section}" class="internal-link" target="_blank" rel="noopener">${label}</a>`;

    const table = `
<table style="border-collapse: collapse; width: 100%; border: 1px solid var(--background-modifier-border);">
<thead>
<tr>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Constitución","CON")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Fuerza","FUE")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Destreza","DES")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Poder","POD")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Cognición","COG")}</th>
</tr>
</thead>
<tbody>
<tr>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${CON}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${FUE}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${DES}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${POD}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${COG}</td>
</tr>
<tr>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Salud","HP")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Evasión","EVA")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Movimiento","MOV")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("PA","PA")}</th>
  <th style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link("Cordura","COR")}</th>
</tr>
<tr>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${HP}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${EVA}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${MOV}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${PA}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${COR}</td>
</tr>
</tbody>
</table>`;

    const newContent = content.replace(
        /<!--STATS-START-->[\s\S]*?<!--STATS-END-->/,
        `<!--STATS-START-->${table}\n<!--STATS-END-->`
    );

    await app.vault.modify(file, newContent);
};