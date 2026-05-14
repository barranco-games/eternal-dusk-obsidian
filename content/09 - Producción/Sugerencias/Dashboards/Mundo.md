## Top
<!-- QueryToSerialize:  
table Votos  
from "09 - Producción/Sugerencias"
where tipo = "area" or tipo = "lore"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
-->
<!-- SerializedQuery: table Votos from "09 - Producción/Sugerencias" where tipo = "area" or tipo = "lore" where estado != "aceptada" and estado != "descartada" sort votos desc limit 10 -->

| File                                                                      | Votos |
| ------------------------------------------------------------------------- | ----- |
| [[Área - Desierto]] | 0     |
| [[Lore - Test]]          | 0     |

<!-- SerializedQuery END -->

## Áreas  
<!-- QueryToSerialize:  
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "areas"
where estado != "aceptada" and estado != "descartada"  
sort votos desc
-->
<!-- SerializedQuery: table Estado, Votos from "09 - Producción/Sugerencias" where tipo = "areas" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File | Estado | Votos |
| ---- | ------ | ----- |

<!-- SerializedQuery END -->
## Lore
<!-- QueryToSerialize: 
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "lore"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
-->
<!-- SerializedQuery: table Estado, Votos from "09 - Producción/Sugerencias" where tipo = "lore" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File                                                             | Estado    | Votos |
| ---------------------------------------------------------------- | --------- | ----- |
| [[Lore - Test]] | pendiente | 0     |

<!-- SerializedQuery END -->
