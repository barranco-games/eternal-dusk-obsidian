## Top  
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias"  
where tipo = "basica" or tipo = "mecanica"
sort votos desc
limit 10
```

## Básicas
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias" 
where tipo = "basica"
sort votos desc
```

## Mecánicas
```dataview  
table Estado, Votos  
from "09 - Producción/Sugerencias" 
where tipo = "mecanica"
sort votos desc
```