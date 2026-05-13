## Top
```dataview  
table Subtipo, Votos, Estado  
from "09 - Producción/Sugerencias"
where tipo = "mision"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
```
## Principales
```dataview  
table estado, votos  
from "09 - Producción/Sugerencias"
where tipo = "mision" and subtipo = "principal"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
```
## Secundarias
```dataview  
table estado, votos  
from "09 - Producción/Sugerencias"
where tipo = "mision" and subtipo = "secundaria"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
```