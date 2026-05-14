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
        `**[[Estadísticas de Agentes#${section}__PIPE__${label}]]**`;

    const table = `
| **Característica** | **Valor** |
|:---|:---:|
| ${link("^descubrir","Descubrir")} | ${descubrir} |
| ${link("^sigilo","Sigilo")} | ${sigilo} |
| ${link("^ocultismo","Ocultismo")} | ${ocultismo} |
| ${link("^lanzar","Lanzar")} | ${lanzar} |
| ${link("^intimidar","Intimidar")} | ${intimidar} |
| ${link("^subterfugio","Subterfugio")} | ${subterfugio} |
| ${link("^perspicacia","Perspicacia")} | ${perspicacia} |
| ${link("^medicina","Medicina")} | ${medicina} |
`;

    const newContent = content
        .replace(
            /<!--SKILLS-START-->[\s\S]*?<!--SKILLS-END-->/,
            `<!--SKILLS-START-->\n${table}<!--SKILLS-END-->`
        )
        .replace(/__PIPE__/g, "\\|");

    await app.vault.modify(file, newContent);
};