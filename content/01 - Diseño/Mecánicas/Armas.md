# General
Las armas afectarán directamente a la habilidad de disparo de la entidad tienen las siguientes características:
- **Daño:** son los dados de daño que usará el arma, además muchas armas tendrán un modificador de daño plano que se le añadirá al resultado de los dados.
- **Alcance:** es el [[Rangos y Áreas#Rangos|Rango]] eficaz del arma.
- **Objetivo:** las armas pueden tener diferentes [[Rangos y Áreas#Áreas de Daño|Áreas de Daño]] dependiendo de su tipo. Por ejemplo un revolver tendrá un objetivo mientras que una escopeta usará un cono.
- **Munición:** Indicará la cantidad de balas que un arma tiene en un cargador.
- **Tipo:** Indica el estilo del arma: ^armas-tipo
	- **Estándar:** Armas de uso general, como el revólver o el cuchillo.
	- **Pesada:** Armas que dependen de la [[Estadísticas de Agentes#Fuerza|Fuerza]], como la escopeta o el martillo.
	- **Precisa:** Armas que dependen de la [[Estadísticas de Agentes#Destreza|Destreza]], como el fusil.
- **Tasa de Acierto:** 95 menos la [[Estadísticas de Agentes#Evasión|Evasión]] del objetivo, más hasta 10 por cercanía. ^tasa-acierto
	- La cercanía da 10 en el borde cercano del [[Rangos y Áreas#Rangos|Rango]] de la habilidad y baja en línea recta hasta 0 en el lejano. Las habilidades que mueven al lanzador, como las cargas, no la reciben.
	- Tira toda habilidad que hace daño, una vez por objetivo, también las de área y contra los aliados que queden dentro. Las que solo aplican estados o curan no tiran.
	- Un ataque que no hace daño cuenta como fallo, pero sus estados se aplican igual.
- **Tirada de Fallo**: Es el resultado de la [[Dados#Tiradas de Estadísticas|Tirada]] hará que el arma se pueda encasquillar, teniendo que gastar [[Estadísticas de Agentes#Puntos de Acciones|PA]] para desencasquillarla. Esto solo se aplica a las armas de fuego. ^tirada-fallo
- **Manejo:** Indica si el arma se puede usar con una o dos manos. ^manos
# Bonificadores de Daño (BD)
La bonificación de daño depende del tipo de daño de la habilidad: el contundente usa la [[Estadísticas de Agentes#Fuerza|Fuerza]] del agente y el perforante su [[Estadísticas de Agentes#Destreza|Destreza]]. El resto de tipos no tiene BD. Solo la suman las habilidades que la indican en su daño, por ejemplo 2D8 + BD.

| **Estadística** | **BD** |
| :------: | :----: |
|   1-20   |   -2   |
|  21-45   |   -1   |
|  45-60   |   -    |
|  61-80   |  +1D4  |
|  81-100  |  +1D6  |
# Durabilidad (Wishlist)
Las armas tienen una durabilidad que se va degradando por el uso, si la durabilidad del arma baja lo suficiente el rango la tirada de fallo del arma aumentará, en caso de ser de fuego. Además perderá precisión y daño, si el arma se descuida y se deja que su durabilidad llegue a 0 acabará rompiéndose.