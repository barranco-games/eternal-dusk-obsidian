## Más votadas
```dataview
table Votos, Estado
from "09 - Producción/Sugerencias"
where tipo and estado != "aceptada" and estado != "descartada"
sort votos desc
limit 10
```

## Pendientes Prioritarias
```dataview
table Votos
from "09 - Producción/Sugerencias"
where tipo and estado = "pendiente"
sort votos desc
limit 10
```

## Más Recientes
```dataview
table Estado
from "09 - Producción/Sugerencias"
where tipo and estado != "aceptada" and estado != "descartada"
sort file.ctime desc
limit 10
```

# Categorías  
- [[Gameplay]]  
- [[Mundo]]  
- [[Personajes]]  
- [[09 - Producción/Sugerencias/Dashboards/Misiones]]