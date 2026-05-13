## Top
```dataview  
table Votos  
from "09 - Producción/Sugerencias"
where tipo = "area" or tipo = "lore"  
where estado != "aceptada" and estado != "descartada"
sort votos desc  
limit 10
```

## Áreas  
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "areas"
where estado != "aceptada" and estado != "descartada"  
sort votos desc
```
## Lore
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias"
where tipo = "lore"  
where estado != "aceptada" and estado != "descartada"
sort votos desc
```