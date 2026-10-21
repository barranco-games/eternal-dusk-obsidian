# **Habilidades Generales**

| **Nombre** | **Coste** | **Descripción** |
| --- | :---: | --- |
| **Puñetazo** | 2 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] | Un golpe seco. |
| **Mover** | - | El agente se moverá a la posición indicada y gastará [[Estadísticas de Agentes#Puntos de Acciones\|PAs]] en función de su [[Estadísticas de Agentes#Movimiento\|Movimiento]]. |
| **Cambio de Postura** | 1 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] | El agente podrá elegir su [[Posturas\|Postura]]. |

# Reacciones (Secundario)
Son acciones que se activan cuando se cumple una condición específica. Algunas tendrán coste de PA y otras podrán costar otro recurso especificado o ambos.

| **Nombre** | **Coste** | **Condición** | **Descripción** |
| --- | :---: | --- | --- |
| **Esquivar** | 1 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] | Golpe [[Rangos y Áreas#Melee\|melee]] contra el agente; [[Dados#Tiradas de Estadísticas\|Tirada]] de [[Estadísticas de Agentes#Evasión\|Evasión]] contra el ataque. |  |
| **Contrataque** | 2 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] | Golpe [[Rangos y Áreas#Melee\|melee]] contra el agente; tirada con el tipo de su arma [[Rangos y Áreas#Melee\|melee]]. |  |
| **Saltar a cubierto** | 1 [[Estadísticas de Agentes#Puntos de Acciones\|PA]] | Ataque a distancia; si supera [[Estadísticas de Agentes#Evasión\|Evasión]], [[Dados#Ventaja y Desventaja\|Desventaja]] al atacante; se aplica [[Estados#^sts-knocked-down\|Derribado]]. |  |
| **Empujar suerte** | - | Tras fallar una tirada por poco. |  |
^tabla-reacciones
# **Movimiento**
El agente puede moverse varias veces en su turno, es decir, el agente puede moverse primero, realizar una acción y volverse a mover si quiere.

La cantidad de unidades que puede avanzar el agente en su turno depende tanto de su [[Estadísticas de Agentes#Movimiento|Movimiento]] como de cuantos [[Estadísticas de Agentes#Puntos de Acciones|Puntos de Acción]] decida usar en su movimiento. Los agentes no se podrán mover a espacios que estén ocupadas por algún otro elemento, ya sea otra agente, un prop del escenario...

Fuera de combate moverse no gasta [[Estadísticas de Agentes#Puntos de Acciones|PA]] ni tiene límite de distancia.

# **Lanzar habilidades**
Una habilidad solo se puede cancelar mientras se apunta. Una vez lanzada se ejecuta hasta el final.

# **Disparar**
Disparar es una acción general que podrá hacer cualquier agente. Cuando dispare se tendrán en cuenta varias cosas:

- **Visibilidad.** Solo podrás seleccionar un enemigo para dispararle si está visible para ti, eso implica que esté dentro del rango de visión de las entidades.
- **Alcance del arma.** Solo podrás disparar a un enemigo si está dentro del [[Rangos y Áreas#Rangos|Rango]] de tu arma.
- **Porcentaje de disparo.** Al disparar se lanzarán los dados, la tirada necesaria a superar dependerá del [[Rangos y Áreas#Rangos|Rango]] al que estés de un enemigo y la habilidad con armas de la entidad.