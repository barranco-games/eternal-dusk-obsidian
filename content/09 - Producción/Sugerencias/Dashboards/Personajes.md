## Top
```dataview  
table Votos  
from "09 - Producción/Sugerencias"
where tipo = "npc" or tipo = "pc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
```

## NPCs  
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "npc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
```
## PCs
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "pc"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
```

