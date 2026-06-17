# General
Las armas afectarán directamente a la habilidad de disparo de la entidad tienen las siguientes características:
- **Daño:** son los dados de daño que usará el arma, además muchas armas tendrán un modificador de daño plano que se le añadirá al resultado de los dados.
- **Alcance:** es el [[Rangos y Áreas#Rangos|Rango]] eficaz del arma.
- **Objetivo:** las armas pueden tener diferentes [[Rangos y Áreas#Áreas de Daño|Áreas de Daño]] dependiendo de su tipo. Por ejemplo un revolver tendrá un objetivo mientras que una escopeta usará un cono.
- **Munición:** Indicará la cantidad de balas que un arma tiene en un cargador.
- **Tipo:** Indica que habilidad usará para calcular su tasa de acierto: ^armas-tipo
	- **Estándar:** Tiene una bonificación plana de 50 para calcular la precisión.
	- **Pesada:** Se le añade su [[Estadísticas de Agentes#Fuerza|Fuerza]].
	- **Precisa:** Se le añade [[Estadísticas de Agentes#Destreza|Destreza]].  
- **Tasa de Acierto:** (25 + **Tipo**/2)% ^tasa-acierto
- **Tirada de Fallo**: Es el resultado de la [[Dados#Tiradas de Estadísticas|Tirada]] hará que el arma se pueda encasquillar, teniendo que gastar [[Estadísticas de Agentes#Puntos de Acciones|PA]] para desencasquillarla. Esto solo se aplica a las armas de fuego. ^tirada-fallo
- **Manejo:** Indica si el arma se puede usar con una o dos manos. ^manos
# Bonificadores de Daño (BD)
La bonificación de daño se calcula según el **[[Armas#^armas-tipo|Tipo]]** del arma.

| **Tipo** | **BD** |
| :------: | :----: |
|   1-20   |   -2   |
|  21-45   |   -1   |
|  45-60   |   -    |
|  61-80   |  +1D4  |
|  81-100  |  +1D6  |
# Durabilidad (Wishlist)
Las armas tienen una durabilidad que se va degradando por el uso, si la durabilidad del arma baja lo suficiente el rango la tirada de fallo del arma aumentará, en caso de ser de fuego. Además perderá precisión y daño, si el arma se descuida y se deja que su durabilidad llegue a 0 acabará rompiéndose.