---
CON: 70
FUE: 80
DES: 55
POD: 75
COG: 45
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
  return `[[Estadísticas de Agentes#${section}|${text}]]`;
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
  return `[[Estadísticas de Agentes#${section}|${text}]]`;
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
 <!--STATS-START-->

<table>
<thead>
<tr>
  <th><a data-href="Estadísticas de Agentes#Constitución" href="Estadísticas de Agentes#Constitución" class="internal-link" target="_blank" rel="noopener">CON</a></th>
  <th><a data-href="Estadísticas de Agentes#Fuerza" href="Estadísticas de Agentes#Fuerza" class="internal-link" target="_blank" rel="noopener">FUE</a></th>
  <th><a data-href="Estadísticas de Agentes#Destreza" href="Estadísticas de Agentes#Destreza" class="internal-link" target="_blank" rel="noopener">DES</a></th>
  <th><a data-href="Estadísticas de Agentes#Poder" href="Estadísticas de Agentes#Poder" class="internal-link" target="_blank" rel="noopener">POD</a></th>
  <th><a data-href="Estadísticas de Agentes#Cognición" href="Estadísticas de Agentes#Cognición" class="internal-link" target="_blank" rel="noopener">COG</a></th>
</tr>
</thead>
<tbody>
<tr>
  <td>70</td>
  <td>80</td>
  <td>55</td>
  <td>75</td>
  <td>45</td>
</tr>
<tr>
  <th><a data-href="Estadísticas de Agentes#Salud" href="Estadísticas de Agentes#Salud" class="internal-link" target="_blank" rel="noopener">HP</a></th>
  <th><a data-href="Estadísticas de Agentes#Evasión" href="Estadísticas de Agentes#Evasión" class="internal-link" target="_blank" rel="noopener">EVA</a></th>
  <th><a data-href="Estadísticas de Agentes#Movimiento" href="Estadísticas de Agentes#Movimiento" class="internal-link" target="_blank" rel="noopener">MOV</a></th>
  <th><a data-href="Estadísticas de Agentes#PA" href="Estadísticas de Agentes#PA" class="internal-link" target="_blank" rel="noopener">PA</a></th>
  <th><a data-href="Estadísticas de Agentes#Cordura" href="Estadísticas de Agentes#Cordura" class="internal-link" target="_blank" rel="noopener">COR</a></th>
</tr>
<tr>
  <td>17</td>
  <td>28</td>
  <td>8</td>
  <td>6</td>
  <td>75</td>
</tr>
</tbody>
</table>
<!--STATS-END-->
# Habilidades
| Nombre            | Efecto                                                                                                                                                                    |                                                  Coste                                                  | CD  | Daño |                    Rango                    |                 Objetivo                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----------------------------------------------------------------------------------------------------: | :-: | :--: | :-----------------------------------------: | :---------------------------------------: |
| Putiazo Aturdidor | Golpea al objetivo y este tendrá que superar una [[Dados#Tiradas de Estadísticas\|Tirada de Constitución]] o estará [[Estados#^catatonico\|Catatónico]] durante un turno. |                          2 [[Estadísticas de Agentes#Puntos de Acciones\|PA]]                           |  4  | 1D10 | [[Rangos y Áreas#^tabla-rangos\|Muy Cerca]] | [[Rangos y Áreas#^tabla-areas\|Objetivo]] |
| Marca             | [[Estados#^marcado\|Marca]] a un enemigo durante 3 turnos.                                                                                                                | 4 [[Estadísticas de Agentes#Puntos de Acciones\|PA]]<br>5 [[Estadísticas de Agentes#Cordura\|Cordura]]  |  5  |  -   |   [[Rangos y Áreas#^tabla-rangos\|Lejos]]   | [[Rangos y Áreas#^tabla-areas\|Objetivo]] |
| Putiazo estados   | Golpea al objetivo y tira un dado de daño extra por cada estado que tenga el objetivo.                                                                                    | 6 [[Estadísticas de Agentes#Puntos de Acciones\|PA]]<br>10 [[Estadísticas de Agentes#Cordura\|Cordura]] |  8  | XD12 |   [[Rangos y Áreas#^tabla-rangos\|Cerca]]   | [[Rangos y Áreas#^tabla-areas\|Objetivo]] |
[[04 - Narrativa/Personajes/Party/Lorenzo|Descripción]]


