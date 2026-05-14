## Top
<!-- QueryToSerialize:  
table Votos  
from "09 - Producción/Sugerencias"
where tipo = "npc" or tipo = "pc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
-->
<!-- SerializedQuery: table Votos from "09 - Producción/Sugerencias" where tipo = "npc" or tipo = "pc" where estado != "aceptada" and estado != "descartada" sort votos desc limit 10 -->

| File                                                             | Votos |
| ---------------------------------------------------------------- | ----- |
| [[PC - asdasdd]] | 1     |
| [[NPC - Test]]    | 0     |

<!-- SerializedQuery END -->

## NPCs  
<!-- QueryToSerialize:   
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "npc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
-->
<!-- SerializedQuery: table Estado, Votos from "09 - Producción/Sugerencias" where tipo = "npc" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File                                                          | Estado    | Votos |
| ------------------------------------------------------------- | --------- | ----- |
| [[NPC - Test]] | pendiente | 0     |

<!-- SerializedQuery END -->
## PCs
<!-- QueryToSerialize: 
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "pc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
-->
<!-- SerializedQuery: table Estado, Votos from "09 - Producción/Sugerencias" where tipo = "pc" where estado != "aceptada" and estado != "descartada" sort votos desc -->

| File                                                             | Estado    | Votos |
| ---------------------------------------------------------------- | --------- | ----- |
| [[PC - asdasdd]] | pendiente | 1     |

<!-- SerializedQuery END -->

