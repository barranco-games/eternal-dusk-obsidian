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
        `**[[Estadísticas de Agentes#${section}__PIPE__${label}]]**`;

    const table = `
| ${link("Constitución","CON")} | ${link("Fuerza","FUE")} | ${link("Destreza","DES")} | ${link("Poder","POD")} | ${link("Cognición","COG")} |
|:---:|:---:|:---:|:---:|:---:|
| ${CON} | ${FUE} | ${DES} | ${POD} | ${COG} |
| ${link("Salud","HP")} | ${link("Evasión","EVA")} | ${link("Movimiento","MOV")} | ${link("PA","PA")} | ${link("Cordura","COR")} |
| ${HP} | ${EVA} | ${MOV} | ${PA} | ${COR} |
`;

    const newContent = content
        .replace(
            /<!--STATS-START-->[\s\S]*?<!--STATS-END-->/,
            `<!--STATS-START-->\n${table}<!--STATS-END-->`
        )
        .replace(/__PIPE__/g, "\\|");

    await app.vault.modify(file, newContent);
};