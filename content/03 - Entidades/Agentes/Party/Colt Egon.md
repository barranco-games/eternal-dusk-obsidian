---
CON: 60
FUE: 50
DES: 75
POD: 65
COG: 85
---
# Estadísticas

```dataviewjs
let p = dv.current();

// stats
let CON = p.CON ?? 0;
let FUE = p.FUE ?? 0;
let DES = p.DES ?? 0;
let POD = p.POD ?? 0;
let COG = p.COG ?? 0;

// PA
let total = COG + POD;
let PA =
  total <= 64 ? 4 :
  total <= 84 ? 5 :
  total <= 124 ? 6 :
  total <= 164 ? 7 : 8;

// MOV
let MOV =
  (DES < CON && FUE < CON) ? 7 :
  (DES > CON && FUE > CON) ? 9 :
  8;

// derivadas
let HP = Math.floor(CON / 4);
let EVA = Math.ceil(DES / 2);
let COR = POD;

// 🔗 función link correcta
function link(text, section) {
  return `[[Estadísticas de Entidades#${section}|${text}]]`;
}

// tabla
dv.table(
[
link("CON","Constitución"),
link("FUE","Fuerza"),
link("DES","Destreza"),
link("POD","Poder"),
link("COG","Cognición")
],
[
[CON, FUE, DES, POD, COG],
[
link("HP","Salud"),
link("COR","Cordura"),
link("EVA","Evasión"),
link("MOV","Movimiento"),
link("PA","Puntos de Acciones")
],
[HP, COR, EVA, MOV, PA]
]
);
```

```dataviewjs

let p = dv.current();

// stats base
let CON = p.CON ?? 0;
let FUE = p.FUE ?? 0;
let DES = p.DES ?? 0;
let POD = p.POD ?? 0;
let COG = p.COG ?? 0;

// habilidades (según tus fórmulas)
let descubrir = 25 + (COG / 2);
let sigilo = 20 + (DES / 2);
let ocultismo = 5 + (POD / 2);
let lanzar = 20 + (FUE / 2);
let intimidar = 15 + ((FUE + POD) / 4);
let subterfugio = 15 + ((DES + COG) / 4);
let perspicacia = 5 + ((POD + COG) / 4);
let medicina = 10 + ((DES + POD) / 4);

// helper link
function link(text, section) {
  return `[[Estadísticas de Entidades#${section}|${text}]]`;
}

// tabla
dv.table(
["Habilidad", "Valor"],
[
[link("Descubrir","^descubrir"), Math.floor(descubrir)],
[link("Sigilo","^sigilo"), Math.floor(sigilo)],
[link("Ocultismo","^ocultismo"), Math.floor(ocultismo)],
[link("Lanzar","^lanzar"), Math.floor(lanzar)],
[link("Intimidar","^intimidar"), Math.floor(intimidar)],
[link("Subterfugio","subterfugio"), Math.floor(subterfugio)],
[link("Perspicacia","Perspicacia"), Math.floor(perspicacia)],
[link("Medicina","Medicina"), Math.floor(medicina)]
]
);
```
# Habilidades
| Nombre          | Efecto                                                                                                                                                                                                        |                         Coste                          | CD  | Daño |                  Rango                  |                 Objetivo                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------: | :-: | :--: | :-------------------------------------: | :---------------------------------------: |
| **Turno extra** | Da al aliado seleccionado un turno adicional al final de su siguiente turno.                                                                                                                                  | 4 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] |  4  |  -   | [[Rangos y Áreas#^tabla-rangos\|Cerca]] | [[Rangos y Áreas#^tabla-areas\|Objetivo]] |
| Tiro Veneno     | El objetivo tendrá que hacer una [[Estadísticas de Agentes#Constitución\|Tirada de Constitución]] o será [[Estados#^veneno\|Envenenado]] durante dos turnos.                                                | 2 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] |  2  | 1D10 | [[Rangos y Áreas#^tabla-rangos\|Lejos]] | [[Rangos y Áreas#^tabla-areas\|Objetivo]] |
| Gas Pimienta    | Los objetivos que se encuentren en el cono tendrán que hacer una [[Estadísticas de Agentes#Constitución\|Tirada de Destreza]] o recibirá el daño y tendrá [[Estados#^temblor\|Temblores]] durante un turno. | 2 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] |  3  | 1D6  | [[Rangos y Áreas#^tabla-rangos\|Medio]] |   [[Rangos y Áreas#^tabla-areas\|Cono]]   |



