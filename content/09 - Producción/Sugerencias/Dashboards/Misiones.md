## Top
<!-- QueryToSerialize: 
table Subtipo, Votos, Estado  
from "09 - Producción/Sugerencias"
where tipo = "mision"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
-->
<!-- SerializedQuery: table Subtipo, Votos, Estado from "09 - Producción/Sugerencias" where tipo = "mision" where estado != "aceptada" and estado != "descartada" sort votos desc limit 10 -->

| File                                                                           | Subtipo    | Votos | Estado    |
| ------------------------------------------------------------------------------ | ---------- | ----- | --------- |
| [[Misión - Prision]] | secundaria | 0     | pendiente |

<!-- SerializedQuery END -->
## Principales
<!-- QueryToSerialize: 
table estado, votos  
from "09 - Producción/Sugerencias"
where tipo = "mision" and subtipo = "principal"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
-->
<!-- SerializedQuery: table estado, votos from "09 - Producción/Sugerencias" where tipo = "mision" and subtipo = "principal" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File | estado | votos |
| ---- | ------ | ----- |

<!-- SerializedQuery END -->
## Secundarias
<!-- QueryToSerialize: 
table estado, votos  
from "09 - Producción/Sugerencias"
where tipo = "mision" and subtipo = "secundaria"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
-->
<!-- SerializedQuery: table estado, votos from "09 - Producción/Sugerencias" where tipo = "mision" and subtipo = "secundaria" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File                                                                           | estado    | votos |
| ------------------------------------------------------------------------------ | --------- | ----- |
| [[Misión - Prision]] | pendiente | 0     |

<!-- SerializedQuery END -->
