# **Principales**
## Constitución
Influye en la vida máxima de la entidad y en su resistencia a ser afectado por estados como [[Estados#^sts-poisoned|veneno]] o [[Estados#^sts-burning|quemado]].
## Fuerza
Influye en su eficacia usando armas pesadas (escopeta, almádena...), y su resistencia a ser afectado por estados como [[Estados#^sts-knocked-down|derribado]].
## Destreza
Establece la posición en el orden de turno, influye en su eficacia usando armas precisas (rifle), y su habilidad de [[Estadísticas de Agentes#Evasión|Evasión]].
## Poder
Influye en la cordura del agente, en su eficacia con ritos y en tiradas contra efectos mentales. Representa resistencia mental, cordura y conocimientos ocultos.
## Cognición
Es la capacidad de un agente para descubrir elementos ocultos, mantener concentración...
Representa agilidad mental, agudeza y claridad.
## Suerte
Sirve para aliviar el RNG de las tiradas y puede influir en los recursos encontrados. La suerte máxima que una entidad puede acumular es 100.
# **Secundarias**
## Salud
Es la cantidad de daño que un agente podrá aguantar antes de morir. Cada agente tendrá un valor base.
- Fórmula para calcular la vida máxima, el resultado se redondeará hacia abajo: 
 base +  [[Estadísticas de Agentes#Constitución|Constitución]]/8.
## Cordura
La cordura representa el estado mental del agente, es un recurso que se podrá usar para pagar el coste de algunas habilidades, el máximo es 100 puntos. La cordura inicial y máxima por agente es igual a su [[Estadísticas de Agentes#Poder|Poder]]. 
## Evasión
Permite al agente esquivar golpes o ataques que vea contra él: se resta a la [[Armas#^tasa-acierto|Tasa de Acierto]] de quien le ataca. Se calcula como 5 + [[Estadísticas de Agentes#Destreza|Destreza]]/10, redondeado hacia arriba.
## Movimiento
Es la distancia máxima que un agente se moverá al gastar un [[Estadísticas de Agentes#Puntos de Acciones|Punto de Acción]]. Cada agente tiene un movimiento base, normalmente de 2 metros, y una bonificación de:

| Si la DES y la FUE son menores que CON                                | 1 metros |
| --------------------------------------------------------------------- | -------- |
| Si la DES o la FUE son igual o mayores que CON o las tres son iguales | 2 metros |
| Si ambas DES y FUE son mayores que CON                                | 3 metros |
## Puntos de Acciones
Es un recurso que los agentes usarán para realizar habilidades. Cada agente tiene una base propia de puntos de acción y una bonificación que variará en función de sus estadísticas principales.
Al inicio de cada [[Turnos|Turno]] el agente recupera todos sus Puntos de Acción hasta el máximo, y los que no gastó en el turno anterior se pierden.

### Bonificador:

| COG + POD | Cantidad |
| --------- | -------- |
| 2–64      | 0        |
| 65–84     | 1        |
| 85–124    | 2        |
| 125–164   | 3        |
| 165–200   | 4        |
## Rango de visión
Es la distancia a la que un agente ve a otras entidades. Los miembros de la [[Party]] ven hasta 13 metros y los enemigos hasta 10 metros.

# **Características**

- **Descubrir**: Encontrar objetos, escuchar. ^descubrir
- **Rastrear**: Seguir huellas, encontrar rastros. ^rastrear
- **Sigilo**: Ocultarse, pasar desapercibido. ^sigilo
- **Ocultismo**: Entender textos prohibidos, lore, ritos... ^ocultismo
- **Lanzar**: Define el rango y la precisión de un agente al arrojar un arma u objeto. ^lanzar
- **Subterfugio**: Desarmar trampas, abrir cerraduras. ^subterfugio
- **Medicina**: Aumenta la eficacia de los medicamentos y comprender el estado físico. ^medicina
- **Perspicacia**: Entender el estado de un personaje y sus intenciones . ^perspicacia
- **Intimidar** ^intimidar
- **Persuadir** ^persuadir
- **Engaño** ^enganio

El valor de cada característica se calcula a partir de las estadísticas principales, redondeando hacia abajo. Rastrear, Persuadir y Engaño todavía no tienen fórmula.

| **Característica** | **Fórmula**          |
| ------------------ | -------------------- |
| Descubrir          | 25 + COG/2           |
| Sigilo             | 20 + DES/2           |
| Ocultismo          | 5 + POD/2            |
| Lanzar             | 20 + FUE/2           |
| Intimidar          | 15 + (FUE + POD)/4   |
| Subterfugio        | 15 + (DES + COG)/4   |
| Perspicacia        | 5 + (POD + COG)/4    |
| Medicina           | 10 + (DES + POD)/4   |

### Bonificador de Medicina
Se añadirá un valor fijo a las tiradas relacionadas con medicamentos en función de la [[Estadísticas de Agentes#^medicina|Medicina]] del agente.

| **Medicina** | **Bonus Medicina** |
| ------------ | ------------------ |
| 0 - 30       | 0                  |
| 31 - 60      | +1                 |
| 61 - 85      | +2                 |
| 86 - 100     | +3                 |

^tabla-bm
### Rango Lanzamientos
La distancia a la que podrá arrojar objetos lanzables dependerá de su habilidad de [[Estadísticas de Agentes#^lanzar|Lanzamiento]].

| **Lanzar** | **Distancia** |
| ---------- | ------------- |
| 0 - 30     | 2.5m          |
| 31 - 60    | 5m            |
| 61 - 85    | 7.5m          |
| 86 - 100   | 10m           |

^tabla-lanzar