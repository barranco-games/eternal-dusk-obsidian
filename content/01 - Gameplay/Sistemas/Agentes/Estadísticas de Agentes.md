# **Principales**
## Constitución
Influye en la vida máxima de la entidad y en su resistencia a ser afectado por estados como [[Estados#^veneno|veneno]] o [[Estados#^quemado|quemado]].
## Fuerza
Influye en su eficacia usando armas pesadas (escopeta, almádena...), y su resistencia a ser afectado por estados como [[Estados#^derribado|derribado]].
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
La cordura representa el estado mental del agente, es un recurso que se podrá usar para pagar el coste de algunas habilidades, el máximo es 100 puntos. La cordura inicial es igual al [[Estadísticas de Agentes#Poder|Poder]]. 
## Evasión
Permite al agente esquivar golpes o ataques que vea contra el. Se calcula como la mitad de la [[Estadísticas de Agentes#Destreza|Destreza]] redondeada hacia arriba.
## Movimiento
Es la distancia máxima que un agente se moverá al gastar un [[Estadísticas de Agentes#Puntos de Acciones|Punto de Acción]]. El movimiento base será de 2 metros y tendrá una bonificación de:

| Si la DES y la FUE son menores que CON                                | 1 metros |
| --------------------------------------------------------------------- | -------- |
| Si la DES o la FUE son igual o mayores que CON o las tres son iguales | 2 metros |
| Si ambas DES y FUE son mayores que CON                                | 3 metros |
## Puntos de Acciones
Es un recurso que los agentes usarán para realizar habilidades. El máximo que un agente puede acumular es 10. Los puntos de acción iniciales de un agente son 4 y tendrá una bonificación de:

| COG + POD | Cantidad |
| --------- | -------- |
| 2–64      | 0        |
| 65–84     | 1        |
| 85–124    | 2        |
| 125–164   | 3        |
| 165–200   | 4        |
# **Características**

- **Descubrir**: Encontrar objetos, escuchar. ^descubrir
- **Rastrear**: Seguir huellas, encontrar rastros. ^rastrear
- **Sigilo**: Ocultarse, pasar desapercibido. ^sigilo
- **Ocultismo**: Entender textos prohibidos, lore Mythos... ^ocultismo
- **Lanzar**: Define el rango y la precisión de un agente al arrojar un arma u objeto. ^lanzar
- **Subterfugio**: Desarmar trampas, abrir cerraduras. ^subterfugio
- **Medicina**: Aumenta la eficacia de los medicamentos. ^medicina
- **Perspicacia**: Entender estado de un personaje e intenciones . ^perspicacia
- **Intimidar**: ^intimidar
- **Persuadir**: ^persuadir
- **Engaño**: ^enganio

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
La distancia a la que podrá tirar objetos lanzables dependerá de su habilidad de [[Estadísticas de Agentes#^lanzar|Lanzamiento]].

| **Lanzar** | **Distancia**                               |
| ---------- | ------------------------------------------- |
| 0 - 30     | [[Rangos y Áreas#^tabla-rangos\|Cerca]]     |
| 31 - 60    | [[Rangos y Áreas#^tabla-rangos\|Media]]     |
| 61 - 85    | [[Rangos y Áreas#^tabla-rangos\|Lejos]]     |
| 86 - 100   | [[Rangos y Áreas#^tabla-rangos\|Muy Lejos]] |

^tabla-lanzar