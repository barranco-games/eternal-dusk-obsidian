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

    const descubrir    = Math.floor(25 + (COG / 2));
    const sigilo       = Math.floor(20 + (DES / 2));
    const ocultismo    = Math.floor(5  + (POD / 2));
    const lanzar       = Math.floor(20 + (FUE / 2));
    const intimidar    = Math.floor(15 + ((FUE + POD) / 4));
    const subterfugio  = Math.floor(15 + ((DES + COG) / 4));
    const perspicacia  = Math.floor(5  + ((POD + COG) / 4));
    const medicina     = Math.floor(10 + ((DES + POD) / 4));

    const link = (section, label) =>
        `<a data-href="Estadísticas de Agentes#${section}" href="Estadísticas de Agentes#${section}" class="internal-link" target="_blank" rel="noopener">${label}</a>`;

    const row = (section, label, value) => `
<tr>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${link(section, label)}</td>
  <td style="padding: 6px 12px; border: 1px solid var(--background-modifier-border); text-align: center;">${value}</td>
</tr>`;

    const table = `
<table style="border-collapse: collapse; width: 100%; border: 1px solid var(--background-modifier-border);">
<tbody>
${row("^descubrir",   "Descubrir",   descubrir)}
${row("^sigilo",      "Sigilo",      sigilo)}
${row("^ocultismo",   "Ocultismo",   ocultismo)}
${row("^lanzar",      "Lanzar",      lanzar)}
${row("^intimidar",   "Intimidar",   intimidar)}
${row("subterfugio",  "Subterfugio", subterfugio)}
${row("Perspicacia",  "Perspicacia", perspicacia)}
${row("Medicina",     "Medicina",    medicina)}
</tbody>
</table>`;

    const newContent = content.replace(
        /<!--SKILLS-START-->[\s\S]*?<!--SKILLS-END-->/,
        `<!--SKILLS-START-->${table}<!--SKILLS-END-->`
    );

    await app.vault.modify(file, newContent);
};