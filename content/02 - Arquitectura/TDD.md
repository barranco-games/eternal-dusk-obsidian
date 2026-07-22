**  

DOCUMENTO DE DISEÑO TÉCNICO

Eternal Dusk

A party-based cosmic-horror investigation CRPG

|   |   |
|---|---|
|Estudio / Equipo|Barranco Games|
|Autor(es)|Sergio Marchena, Carlos Márquez|
|Última actualización|Junio 2026|
|Estado|Documento vivo, v1.0|

  
  

Contenidos

  

# 1. Introducción

Este Documento de Diseño Técnico (TDD) es el plano de ingeniería de Eternal Dusk, un juego desarrollado por Barranco Games en Unity. Es la referencia del equipo de programación sobre cómo está construido el juego: su arquitectura, sistemas, herramientas y convenciones.

Al igual que la documentación de diseño que acompaña, este TDD es un documento vivo: se espera que cambie a medida que el proyecto evolucione, se añadan funcionalidades y el equipo aprenda más sobre las restricciones de las plataformas objetivo. Las secciones pueden ampliarse, reorganizarse o eliminarse a medida que Eternal Dusk tome forma.

## 1.1 ¿Qué es este documento?

Un TDD permite al equipo especificar qué requiere cada funcionalidad, acordar cómo debe implementarse y registrar las bibliotecas, características del motor y convenciones involucradas. También sirve como referencia al comunicar el estado técnico del proyecto a terceros como editoras.

Eternal Dusk está construido sobre una arquitectura por capas (Core, Gameplay, Systems, y Engine) en la que las capas internas son C# puro y solo la capa Engine toca Unity. Las dependencias se resuelven mediante inyección de dependencias, y el rendimiento del juego es un pilar central. Las capas, las reglas de dependencia y las bibliotecas involucradas se detallan en las secciones 2.5 y 2.6.

## 1.2 Relación con el GDD

Eternal Dusk se describe mediante dos documentos vivos paralelos. El Documento de Diseño del Juego (GDD) es una descripción funcional del juego desde el punto de vista del jugador: qué es el juego, cómo se juega y qué experiencia debe ofrecer. Este TDD es la descripción arquitectónica del mismo juego desde el punto de vista del implementador: cómo esas experiencias se convierten en código, qué sistemas son responsables de ellas y cómo encajan dentro de la arquitectura por capas.

Los dos documentos evolucionan juntos. Las funcionalidades definidas en el GDD se resumen y se les da un plan técnico aquí (véase la sección 2.1), y las restricciones descubiertas durante la implementación retroalimentan el diseño. Siempre que cambie el GDD, se deben revisar las secciones técnicas afectadas de este documento.

# 2. Secciones Principales

## 2.1 Funcionalidades del GDD

Eternal Dusk es un CRPG de horror cósmico con combate táctico por turnos, diseñado para trasladar la sensación de una sesión de rol de mesa a un videojuego. El misterio y el horror son centrales: la investigación es la acción principal del jugador y la columna vertebral de la progresión. Esta sección resume las funcionalidades que inciden más directamente en el trabajo técnico; el GDD sigue siendo la fuente autoritativa de la intención de diseño.

### Pilares de diseño

- Mundo hostil: el jugador nunca debe sentirse seguro ni superior a sus enemigos o al entorno, y menos aún a las entidades cósmicas.
    
- El poder en el conocimiento: cuanto más entienda el jugador el mundo y su naturaleza, mejor podrá superar sus desafíos; el juego debe recompensar la curiosidad y la exploración.
    
- Duelo colectivo: no hay personajes ni escenarios felices; la inquietud es una sensación constante.
    
- Juego de mesa: capturar la esencia de una sesión de rol de mesa.
    

### Bucle principal

- Investigar: la acción central, impulsada por el enfoque en el misterio y el horror.
    
- Recompensas: la investigación ancla la progresión; la exploración también proporciona recursos, equipamiento y consumibles.
    
- Crecer en poder: los jugadores gastan recursos en comerciantes, equipan o venden objetos, y mejoran las características y habilidades de sus agentes.
    
- Encuentros: narrativos o de combate; superarlos avanza las investigaciones, desafía al jugador y puede proporcionar recompensas.
    

### Sistemas clave

Las funcionalidades anteriores se implementan mediante un conjunto de sistemas, resumidos a continuación y especificados en detalle en la sección 2.6.

|Sistema|Resumen|
|---|---|
|Estadísticas|Atributos, estadísticas de combate y derivadas, aptitudes y resistencias para cada actor, resueltos mediante un pipeline de modificadores.|
|Recursos|Recursos como salud, puntos de acción y cordura, con una capa de simulación sin alocaciones para IA y planificación.|
|Cordura, trauma y virtud|Una mecánica de salud mental, derivada de un recurso, que alimenta los estados narrativos y de combate.|
|Combate por turnos y dados|Iniciativa, puntos de acción y tiradas de dados que evocan el juego de mesa.|
|Investigación|El sistema de investigación y pistas que regula la progresión.|
|Áreas|Niebla de guerra, visión de unidades y fijación de objetivos de habilidades en un mundo amplio y en streaming (el Sistema de Áreas).|
|Misiones y escenarios|Misiones principales y secundarias en escenarios creados a mano.|
|Economía|Recursos, comerciantes, equipamiento, consumibles e inventario.|

## 2.2 Objetivos técnicos

Estos objetivos expresan lo que el equipo de ingeniería pretende lograr en el código, el motor y la plataforma objetivo. Guían las decisiones de diseño y tecnología y se revisan a medida que el proyecto evoluciona.

|#|Objetivo técnico|Por qué es importante|Prioridad|
|---|---|---|---|
|1|Aislamiento estricto de capas|Confinar Unity y los plugins de terceros en la capa Engine para que las capas internas sean portables y testeables.|Alta|
|2|Juego de alto rendimiento|Eliminar las alocaciones en hot paths y mantener el coste por fotograma predecible para que el juego sea rápido a escala.|Alta|
|3|Corrección a escala|Soportar un mundo amplio en streaming sin recomputación global cuando cambia el estado.|Alta|
|4|Configuración orientada a datos|Expresar el comportamiento (estadísticas, recursos, áreas) como datos editados en lugar de ramas de código.|Alta|
|5|Extensibilidad sin efecto cascada|Añadir una estadística, recurso, tipo de daño o tipo de área debe afectar al mínimo de código bien definido.|Alta|
|6|Resolución determinista|La resolución de estadísticas y daños sigue una fórmula explícita única, independiente del orden de registro.|Media|
|7|Desacoplamiento mediante DI|Resolver dependencias a través de Reflex para que los sistemas puedan intercambiarse, simularse y probarse de forma aislada.|Media|
|8|Simulación segura para IA|Proporcionar snapshots de tipos de valor para que el código de IA y planificación nunca mute el estado del juego en vivo.|Media|

  

## 2.3 Riesgos técnicos

Estos son los riesgos técnicos identificados para el proyecto, cada uno con una gravedad inicial y una mitigación. Las gravedades son una evaluación inicial y deben revisarse a medida que el proyecto avanza. Las plataformas objetivo son PC, Mac y Linux, lo que mantiene bajos los riesgos específicos de plataforma (GPU y memoria).

|Riesgo|Impacto|Gravedad|Mitigación|
|---|---|---|---|
|Picos de fotograma del Sistema de Áreas en cambio de región|Las subidas de vértices al cruzar límites de chunks pueden superar el presupuesto de fotograma y causar tirones visibles durante la exploración.|Media|Amortizar los bakes entre fotogramas, mantener la puerta de actualización a 30 Hz, precalentar los chunks adyacentes y perfilar en el hardware objetivo.|
|Regresiones de rendimiento en rutas críticas|Las asignaciones o LINQ que se cuelen en el código por fotograma o en el código central causan un aumento gradual del tiempo de fotograma y picos de GC.|Media|Disciplina de asignación y analizadores (2.4), perfilado periódico y los presupuestos de 2.8 como puertas de regresión.|
|Erosión de los límites de capa|Las referencias a Unity o plugins que se filtren en las capas internas rompen su diseño independiente del motor y perjudican la comprobabilidad.|Media|Aplicar límites con referencias de definición de ensamblado, revisión de código y una prueba de arquitectura.|
|Compatibilidad de guardado y deuda de migración|A medida que los formatos de estado de entidad evolucionan, las partidas antiguas se rompen o los caminos de migración acumulan ramas sin probar, arriesgando el progreso perdido.|Media|Versionar cada envolvente de guardado, cubrir las migraciones con pruebas y establecer una política de soporte para versiones anteriores.|
|Dependencia de terceros atada|Articy, FMOD, Reflex y UniTask condicionan las actualizaciones, las licencias y el soporte de plataforma; algunos son difíciles de reemplazar.|Media|Fijar versiones, aislar cada dependencia detrás de adaptadores de la capa Engine y hacer seguimiento de los términos de licencia (2.5).|
|Complejidad de compilación de DI y generadores de código|La inyección generada y el grafo del contenedor pueden fallar en tiempo de compilación o resolverse de forma opaca, ralentizando la depuración y la incorporación.|Baja/Media|Mantener los instaladores explícitos, validar el contenedor al inicio y documentar los requisitos del generador.|
|Inestabilidad arquitectónica de sistemas en diseño|La cordura/trauma y la investigación aún están en fase de diseño y pueden forzar cambios en los contratos de capas internas que de otro modo serían estables.|Baja/Media|Mantener las interfaces mínimas y orientadas a datos, endurecerlas tarde y aislar los sistemas volátiles.|
|Huella de memoria|El Sistema de Áreas tiene un presupuesto aproximado de ~79 MB; en escritorio esto es menor pero no debe crecer sin control.|Baja|Establecer un presupuesto de memoria para todo el proyecto, perfilar el uso real y mantener bajo control la huella del constructor de mallas.|

  

## 2.4 Guía de estilo de código

Estas convenciones mantienen el código consistente y fácil de leer para todo el equipo. Cubren el lenguaje, el formato, el nombre y los patrones utilizados en todo el proyecto. El código nuevo las sigue; el código existente se adapta a ellas cuando se toca. Estas reglas pueden romperse en casos especiales si el resultado es más legible o tiene mejor rendimiento.

### Lenguaje y formato

- El proyecto está escrito en C# sobre el entorno de scripting de Unity.
    
- La sangría usa tabulaciones. Las llaves siguen el estilo Allman, con cada llave en su propia línea.
    
- Los namespaces tienen ámbito de bloque y reflejan la arquitectura, EternalDusk.<Layer>.<Area> (por ejemplo EternalDusk.Systems.UI.Dialogue). El primer segmento después de la raíz es siempre la capa.
    
- Un tipo principal por archivo. Un pequeño tipo auxiliar estrechamente relacionado (un enum o struct de apoyo) puede compartir el archivo.
    
- Cada archivo se abre con el comentario de encabezado estándar, insertado automáticamente por el generador de código del proyecto, y no se escribe a mano:
    

|   |
|---|
|/*<br><br>**  LevelContext<br><br>**<br><br>**  Created by <Author> on <dd/mm/yyyy><br><br>**  Copyright © <year>, Barranco Games. All rights reserved.<br><br>*/|

  

### Usings

Las directivas using se agrupan en un orden fijo, separadas por líneas en blanco: primero los namespaces de System, luego Unity, luego de terceros (como Reflex), luego los propios namespaces de EternalDusk del proyecto ordenados por capa de Core hacia afuera.

|   |
|---|
|using System;<br><br>using System.Collections.Generic;<br><br>using UnityEngine;<br><br>  <br><br>using Cysharp.Threading.Tasks<br><br>using Reflex.Attributes;<br><br>using EternalDusk.Core.Persistence;<br><br>using EternalDusk.Systems.UI;<br><br>using EternalDusk.Engine.World;|

  

### Nomenclatura

- Los tipos, métodos, propiedades, eventos y constantes usan PascalCase. Las interfaces llevan el prefijo I (IDialogueView, IGameStateService).
    
- Los campos privados usan un guión bajo inicial y camelCase (_choiceButtons, _awaitingChoice); las variables locales y los parámetros son camelCase.
    
- Las constantes son PascalCase, no upper-snake-case (ChunkSize, SkillMaxRange).
    
- Los sufijos de rol se usan de forma consistente: View, Presenter, Service, Installer, Context, Manager, Factory, Registry, Provider, Builder.
    
- Los sufijos de datos tienen significado: Data para snapshots de valor serializables (TransformData), Definition para datos de ScriptableObject editados, y State para el estado de guardado.
    

### Variables y campos

- Fields are explicitly private y readonly whenever they are not reassigned.
    
- Usar var cuando el tipo es obvio por el lado derecho (constructores, casts, llamadas a factorías); usar el tipo explícito en caso contrario, especialmente para primitivos.
    
- Preferir new() tipado por objetivo donde el tipo ya está indicado a la izquierda.
    
- Inicializar las colecciones vacías con Array.Empty<T>() en lugar de asignar una nueva lista o array vacía.
    

### Flujo de control

- Favorecer las cláusulas de guarda y los retornos tempranos sobre los condicionales anidados (if (!Initialized) return;).
    
- Comprobar booleanos directamente: if (used), no if (used == true).
    
- Las llaves pueden omitirse para una sola sentencia guardada en una línea (if (wasHidden) _armed = false;); usar llaves para todo lo que sea más largo.
    
- En rutas críticas o de UI, preferir los bucles for indexados sobre foreach para evitar la asignación del enumerador, y capturar el índice del bucle en una variable local antes de usarlo en un cierre.
    
- Usar ?? throw para las búsquedas obligatorias que no deben devolver null.
    

### Tipos y clases

- Las clases concretas deben ser marcadas como sealed; solo pueden desmarcarse si alguna otra clase debe heredar de ella.
    
- Los contratos viven en las capas internas y las implementaciones en Engine: una interfaz como IDialogueView estará en Systems, mientras que un MonoBehaviour reside en Engine.
    
- Usar la implementación explícita de interfaz para mantener limpias las superficies públicas (IActorStats IActor.Stats => Stats;).
    
- Preferir pequeños structs para datos de valor simple.
    
- Exponer la construcción controlada a través de métodos factorías estáticos Create con constructores privados.
    

### Orden de miembros

Los miembros dentro de un tipo siguen un orden consistente: constantes, luego estáticos, campos serializados, campos inyectados, campos privados, propiedades, eventos, métodos públicos y finalmente métodos privados.

### Inyección de dependencias y composición

Las dependencias se resuelven a través de Reflex, y la UI sigue una separación Modelo-Vista-Presentador:

- View (Engine, MonoBehaviour) posee los elementos visuales, expone eventos de C# puro y no sabe nada de la lógica del juego.
    
- Presenter (Systems) se suscribe a los eventos de vista y de dominio, traduce entre ellos e implementa IDisposable para darse de baja simétricamente.
    
- Service coordina los presentadores detrás de una interfaz (IUIService).
    
- Los installers implementan IInstaller y registran los bindings de forma fluida, indicando Lifetime y Resolution (Lazy o Eager).
    
- MonoBehaviours receive Unity references via [SerializeField] y servicios inyectados mediante [Inject]; los tipos que usan inyección por campo son [SourceGeneratorInjectable] y partial. Las clases simples usan inyección por constructor.
    

### Registro (logging)

- Todo el registro pasa por la fachada estática Log en EternalDusk.Core.Logging, que reenvía a una implementación ILogger: EDLogger en tiempo de ejecución, NullLogger por defecto. Nunca llamar directamente a Debug.Log o Debug.LogFormat; un analizador lo marca y apunta al equivalente Log.
    
- Los niveles son Verbose, Info, Warn, y Error, más Assert. Los mensajes por debajo del nivel actual se omiten.
    
- Cuando un mensaje es costoso de construir (interpolación o concatenación de strings), usar la sobrecarga Func<string> para que solo se evalúe cuando el nivel está activo: Log.Warn(() => $"..."). Un analizador marca los mensajes costosos pasados a la sobrecarga de string simple. Los mensajes constantes o baratos pueden usar la sobrecarga de string directamente.
    

### Disciplina de asignación

- Mantener las rutas críticas sin asignaciones: cachear delegados, reutilizar buffers, usar Array.Empty<T>() por defecto, y evitar LINQ y cierres por fotograma (véanse los objetivos técnicos en la sección 2.2).
    

### Comentarios

- Usar /// para resúmenes XML en tipos públicos y contratos no obvios.
    
- Añadir comentarios en línea cortos solo donde la intención no sea obvia a partir del código.
    

## 2.5 Bibliotecas externas

Estas son las bibliotecas de terceros de las que depende el proyecto.

|Biblioteca|Versión|Propósito|Licencia|
|---|---|---|---|
|Reflex|14.3.1|Contenedor de inyección de dependencias utilizado para resolver dependencias en todas las capas.|MIT|
|UniTask|2.5.1|async/await eficiente en asignaciones para Unity; se usa en todas las capas para trabajo distribuido en fotogramas y trabajo asíncrono.|MIT|
|Articy|Draft X|Autoría de narrativa y diálogos; las entidades se enlazan con objetos de Articy y poseen conversaciones.|Propietario|
|FMOD|2.03.13|Middleware de audio para música adaptativa y efectos de sonido, integrado a través de la capa Engine.|Propietario|

  

El proyecto también depende de paquetes oficiales de Unity distribuidos a través del Package Manager: el Input System (gestión de entrada) y Cinemachine (cámara), junto con el Job System, Burst y los compute shaders utilizados por la capa Engine. Estas son tecnologías propias de Unity más que dependencias de terceros.

## 2.6 Visión general de la organización del código

Esta sección describe cómo está estructurado el código: la arquitectura por capas, el modelo de entidad sobre el que se construyen la mayoría de los objetos del juego y los sistemas principales (en las subsecciones que siguen).

### Arquitectura y capas

El código está dividido en cuatro capas. Ordenadas de la más interna a la más externa son Core, Gameplay, Systems, y Engine. Las dependencias apuntan hacia adentro: una capa puede usar las capas interiores pero nunca las exteriores, y Core no depende de nada más que de sí misma. Solo Engine referencia Unity y plugins de terceros; las únicas excepciones son Reflex y UniTask, permitidos en cada capa. Las dependencias se conectan a través de Reflex.

- Core: primitivas y contratos independientes del motor, incluyendo identificadores como EntityId y PrefabId, datos de tipo de valor y los buses unificados (por ejemplo StatType y ResourceType). C# puro, y el código más sensible al rendimiento.
    
- Gameplay: reglas del juego y definiciones construidas sobre Core, incluyendo las categorías de estadísticas concretas (atributos, combate, derivadas, aptitudes, resistencias), tipos de daño y tipos de recursos como Health, ActionPoints, y Sanity.
    
- Systems: servicios que coordinan el juego, incluyendo el mediador de estadísticas y el pipeline de modificadores, el caché y la simulación del estado de los recursos, el pipeline de áreas y la orquestación de guardar/restaurar.
    
- Engine: la única capa consciente de Unity y los plugins, con entidades MonoBehaviour, shaders de renderizado y cómputo, entrada, integración de Articy y FMOD, y los adaptadores que vinculan los sistemas internos al entorno de ejecución.
    

Un pilar central de esta estructura es un juego de alto rendimiento: con las capas internas independientes del motor y sin alocaciones, la lógica más frecuentemente ejecutada se mantiene rápida, mientras que la capa Engine absorbe todo lo específico de Unity.

### Modelo de entidad

Todo lo que el jugador puede interactuar es una Entity. Las entidades viven en la capa Engine como MonoBehaviour y forman una jerarquía de tres niveles de capacidad creciente.

|Tipo|Representa|Añade|
|---|---|---|
|Entity<TState>|Cualquier cosa con la que se puede interactuar en el mundo.|EntityId y PrefabId estables, posición en el mundo con un evento de cambio basado en push, guardado/restauración versionado, selección/resaltado y enlace con Articy.|
|Actor<TState, …>|Una entidad con salud y comportamiento más rico.|Mediador de Resources, Stats, Resistances, Health y un controlador de efectos de estado; hooks de inicio/fin de turno.|
|Agent<TState>|Personas y monstruos.|Habilidades, equipamiento y los recursos de agente puntos de acción, munición y cordura; refresca los PA y avanza los cooldowns cada turno.|

  

Cada Entity<TState> lleva un EntityId y un PrefabId estable, expone su Position en el mundo, y lanza OnPositionChanged solo cuando realmente se mueve, y esta señal basada en push es lo que alimenta los reveladores del Sistema de Áreas. La clase se divide en archivos partial por responsabilidad:

- Core y Persistencia: cada entidad captura y restaura un estado tipado a través de un SaveEnvelope. Version y Migrate permiten que las partidas antiguas se actualicen cuando cambia el formato del archivo de guardado.
    
- Visual e Interacción: la selección y el hover impulsan un estado de resaltado que cambia la capa de renderizado del objeto (default, candidate, outline, selected) para el resaltado y la retroalimentación de objetivo.
    
- Narrativa: las entidades pueden enlazarse a un objeto de Articy y poseer una conversación, conectándose al sistema de diálogo y narrativa.
    

Un Actor es una entidad con salud y comportamiento más complejo: posee Recursos, Estadísticas, Vida, y un controlador de efectos de estado, se inicializa desde una IActorDefinition, y avanza los efectos de estado al inicio y al final del turno.

Un Agent, es el tipo utilizado para personas y monstruos, añade habilidades, equipamiento y los recursos de agente puntos de acción, munición y cordura; construye su AgentStats (atributos, resistencias, aptitudes, derivadas) desde una definición, y refresca los puntos de acción y los cooldowns de habilidades al inicio de cada turno.

### Especificaciones de los sistemas

La especificación técnica detallada de cada sistema se mantiene en el capítulo de arquitectura del vault del GDD, que es la fuente única de verdad. Para evitar la duplicación y el riesgo de que este documento quede desactualizado, los sistemas se referencian aquí en lugar de reproducirse. El Sistema de Áreas es el más cercano a su versión final; los demás están en distintas etapas.

- [[Action System]]: controlador de cualquier cosa que una entidad haga durante un periodo de tiempo.
    
- [[Area System]]: consultas espaciales aceleradas por GPU para la niebla de guerra, visión de unidades y fijación de objetivos de habilidades en un mundo amplio y en streaming.
    
- [[Stats System]]: atributos, estadísticas de combate y derivadas, aptitudes y resistencias resueltos a través de un pipeline de modificadores.
    
- [[Resources System]]: recursos acotados (salud, puntos de acción, cordura, munición) con una capa de simulación sin asignaciones para IA y planificación.
    
- [[Save & Load System]]: captura y restauración versionada por entidad, con soporte de migración para formatos de guardado anteriores.
    
- [[Quest System]]: seguimiento y progresión de misiones principales y secundarias.
    

TODO: Un diagrama de arquitectura debe acompañar esta sección.

|   |
|---|
|[ Diagrama de arquitectura ]|

## 2.7 Política de ramas

El modelo de ramas usa ramas de larga duración master y develop con ramas de corta duración para funcionalidades y correcciones. La estructura de ramas y la convención de nomenclatura están definidas ([Representación Visual](https://drive.google.com/file/d/1h5U6k1IXgpsnfa_IcXHHb-gEemEMg2k8/view)); las reglas que las rodean (cuándo ramificar y fusionar, los requisitos de revisión y el proceso de lanzamiento) están aún por acordar por el equipo.

### Ramas

- master: la rama estable.
    
- develop: la rama de integración donde se reúne el trabajo en curso.
    
- feature/… y bugfix/…: ramas de corta duración para una sola funcionalidad o corrección, cada una vinculada a un issue de GitHub.
    

### Convención de nomenclatura

Las ramas de feature y bugfix siguen este patrón:

|   |
|---|
|<type>/ED-<issue>_<branch-name>|

  

- <type>: ya sea feature o bugfix.
    
- ED-<issue>: el prefijo del proyecto ED seguido del número de issue de GitHub que aborda la rama.
    
- <branch-name>: un nombre corto y descriptivo para el trabajo.
    

Por ejemplo:

|   |
|---|
|feature/ED-142_area-fog-of-war<br><br>bugfix/ED-207_save-migration-crash|

  

### Por definir

- Quién realiza las fusiones y qué comprobaciones (compilación, pruebas, analizadores) deben pasar primero.
    

## 2.8 Presupuestos de rendimiento

Los presupuestos de rendimiento son límites en las métricas que afectan al funcionamiento del juego. Son un punto de referencia para las decisiones de diseño y tecnología, no una garantía, y pueden cambiar a medida que el proyecto evolucione.

Las cifras que se muestran a continuación provienen de la especificación del Sistema de Áreas y son estimaciones razonadas, no medidas perfiladas. Asumen un objetivo de 60 fps en una GPU de gama media y deben reemplazarse con capturas del perfilador en el hardware objetivo antes de tratarse como presupuestos aplicables.

### Presupuesto de fotograma

|Métrica|Objetivo|Notas|
|---|---|---|
|Tasa de fotogramas|60 fps|Presupuesto de 16.7 ms por fotograma; los costes por fotograma a continuación se miden contra él.|
|Tasa de actualización del Sistema de Áreas|30 Hz|Limitado a como máximo una vez por fotograma de Unity, aproximadamente cada dos fotogramas renderizados.|
|Tiempo de carga de nivel|Por definir|Por definir y medir en el hardware objetivo.|
|Tamaño de la build|~30 GB|Se situará entre los tamaños de Divinity: Original Sin 2 y Baldur's Gate 3.|

  

### Sistema de Áreas (estimado)

Coste estimado de CPU en el hilo principal de la actualización del Sistema de Áreas, asumiendo ~4 a 8 reveladores en una GPU de gama media. La mayor parte del trabajo real ocurre en la GPU.

|Escenario|CPU hilo principal|Notas|
|---|---|---|
|Estado estable (cámara estática, sin fijación de objetivos)|~0.1 a 0.3 ms (~1 a 2%)|Programación y construcción de consultas sobre un pequeño número de áreas y consultas.|
|Exploración activa (desplazándose entre límites de chunks)|picos breves ~1 a 2 ms (~6 a 12%)|Dominado por la subida de vértices de ~13 MB en el cambio de región más una fila de bakes de chunks.|
|Fijación de objetivos de habilidades|muy por debajo del estado estable|Una consulta única adicional y un paso del rastreador de visibilidad.|

  

En memoria, el Sistema de Áreas presupuesta aproximadamente ~79 MB, unos ~17 MB en la GPU y ~62 MB en la CPU, donde los constructores de mallas de niebla y visión dominan con ~55 MB. Un presupuesto de memoria para todo el proyecto está aún por definir.

## 2.9 Método de entrega de la build

El proceso de compilación y entrega aún no está definido. Las siguientes decisiones permanecen abiertas:

- Cómo se producen las builds (manualmente o de forma automatizada mediante CI) y con qué disparadores.
    
- Dónde se entregan y almacenan las builds y en qué formato.
    
- Quién es responsable de producir y distribuir las builds y con qué frecuencia.
    

## 2.10 Lista de versiones TODO:

La hoja de ruta de versiones aún no está definida. Una vez que el equipo acuerde los hitos, cada versión planificada y sus funcionalidades objetivo se listan aquí. Las filas a continuación son un andamiaje de marcadores.

|Versión|Funcionalidades planificadas|Fecha objetivo|Estado|
|---|---|---|---|
|v0.1|Por definir|Por definir|Borrador|
|v0.2|Por definir|Por definir|Planificada|
|v0.3|Por definir|Por definir|Planificada|
|v1.0|Por definir|Por definir|Planificada|

  

## 2.11 Plataforma de entrega y requisitos

Eternal Dusk tiene como objetivo las plataformas de escritorio: Windows, macOS y Linux. El objetivo de rendimiento es situarse entre Divinity: Original Sin 2 y Baldur's Gate 3: más exigente que el primero y más ligero que el último, poniendo el juego al alcance del hardware de escritorio de gama media de los últimos años. Las cifras a continuación son una hipótesis basada en esos dos puntos de referencia.

|Componente|Mínimo|Recomendado|
|---|---|---|
|SO|Windows 10, macOS 11 o Linux (64 bits)|Windows 10/11, macOS actual o Linux (64 bits)|
|CPU|Cuatro núcleos (p. ej. Intel Core i5-4xxx o AMD Ryzen 3)|6 núcleos (p. ej. Intel Core i5-8400 o AMD Ryzen 5 2600)|
|RAM|8 GB|16 GB|
|GPU|2 GB de VRAM (p. ej. NVIDIA GTX 1050 o AMD RX 560)|~6 GB de VRAM (p. ej. NVIDIA GTX 1660 o AMD RX 590)|
|Disco|~30 GB, SSD recomendado|~30 GB en SSD|

  

Estos valores son una hipótesis, no un objetivo medido. El valor de almacenamiento es una estimación aproximada que depende del alcance final de los assets. Todos los valores deben confirmarse mediante perfilado en el hardware objetivo (véanse los presupuestos de rendimiento en la sección 2.8).

# 3. Secciones Adicionales

## 3.1 Elección del motor de juego

El juego está construido en Unity. El equipo ha trabajado con Unity durante los últimos diez años, por lo que el motor es bien conocido, y su apertura permite al equipo construir los sistemas que el juego necesita en lugar de trabajar alrededor de un framework opinado. Esa flexibilidad es lo que hace posible la arquitectura personalizada y orientada al rendimiento de la sección 2: el Sistema de Áreas impulsado por GPU, la configuración de inyección de dependencias y la organización del código por capas.

Unity también proporciona la tecnología de soporte de la que depende el proyecto: scripting en C#, un amplio ecosistema de paquetes y características de bajo nivel como el C# Job System, Burst y los compute shaders.

## 3.2 Herramientas de arte y audio

### Figma

Se utiliza principalmente para la interfaz del juego. El uso de vectores y herramientas de las que dispone lo hacen una herramienta muy potente en este campo, además de que tiene una versión gratuita bastante completa.

### Blender

Programa gratuito para trabajar en el entorno 3D. Permite crear objetos 3D, hacer y modificar UVs, crear y modificar materiales y shaders, texturizar el modelo directamente pintando por encima, esculpido 3D, renderizar, etc.

  

Es muy completo, tiene buena documentación disponible y hay tutoriales de todo tipo para cada área que cubre. También dispone de una gran variedad de “Addons” para facilitar y customizar distintas partes y funciones del programa.

### Photoshop / Krita / Clip Studio / Procreate

Estos tres programas son los que estamos usando actualmente. Photoshop, Clip Studio y Procreate, principalmente para ilustraciones, fondos y texturizado y Krita para texturas tileables, ya que tiene la función de “wrapping”.

  

### FMOD Studio

El sistema de sonido que viene por defecto en Unity es un poco pesado y obliga al procesador a hacer demasiadas tareas a la vez en el Main Thread del juego. FMOD Studio funciona como un "motor independiente" que se encarga de toda la música dinámica y efectos, dejando libre al juego para que funcione de forma más óptima. Los diseñadores de audio pueden cambiar cómo suena un sonido o cómo reacciona la música directamente en FMOD Studio, sin que los programadores tengan que tocar ni una sola línea del código base del juego en Unity.

  

|Tipo de recurso|Sample Rate|Canales|Formato Origen|Compresión Final|
|---|---|---|---|---|
|Sonido Corto (SFX)|48.000 Hz|Mono|WAV 24-bit PCM|ADPCM / PCM|
|Sonido Largo (Música/Amb)|48.000 Hz|Mono/Stereo|WAV 24-bit PCM|OGG Vorbis|

  

#### Infraestructura de Audio

El audio de Eternal Dusk se implementa mediante un pipeline en tres etapas 

1. Procesamiento en DAW ([REAPER](https://www.reaper.fm/)): Es el DAW más rápido, estable y flexible del mercado para trabajar en videojuegos. Actúa como la estación de renderizado y automatización batch de assets a nivel de producción.
    
2. Gestión del Middleware ([FMOD Studio](https://www.fmod.com/studio/)): Funciona como un motor de ejecución asíncrono y asilado que procesa la mezcla, la espacialización 3D, y las estructuras musicales interactivas en hilos dedicados de bajo nivel, liberando al Main Thread de Unity y eliminando GC Allocs en los hot paths del bucle de fotograma. Adicionalmente, empaqueta los assets en bancos segmentados (.bank) aplicando perfiles de compresión dinámicos (ADPCM para SFX iterativos de baja latencia; Vorbis para streaming de buffers largos), optimizando la huella de memoria en tiempo de ejecución.
    
3. Integración en Unity ([Unity Package](https://assetstore.unity.com/packages/tools/fmod-for-unity-2-03-upm-1082237)): Las capas internas interactúan controlando el comportamiento dinámico del audio a través de la inyección de parámetros basados en tipos de valor puro extraídos de los snapshots del juego. La carga de los bancos de sonido se orquesta de forma asíncrona mediante el sistema de Addressables en consonancia con el streaming de chunks del mundo.
    

## 3.3 Objetos 3D, terreno y gestión de escenas

La gestión de assets y escenas utilizará el sistema Addressables de Unity. Addressables carga contenido (prefabs, escenas y otros assets) bajo demanda por dirección en lugar de mediante referencias directas, lo que mantiene la memoria bajo control y desacopla lo que se carga de donde se referencia. Esto se alinea naturalmente con el modelo de entidad, donde cada objeto ya lleva un PrefabId estable (sección 2.6).

La agrupación de assets, la estrategia de carga y cómo Addressables interactúa con la carga de niveles y el streaming del terreno del Sistema de Áreas están aún por detallar.

## 3.4 Inteligencia Artificial

La IA más exigente se ejecuta durante el combate, que es por turnos; fuera del combate, el comportamiento del agente es comparativamente ligero. La idea guía es ocultar la computación de IA detrás de los momentos que el jugador ya está observando. Durante el turno del jugador, y mientras se desarrollan las secuencias de acción y animación, la IA almacena en caché el estado y computa lo que necesita para su propio turno, de modo que cuando el control le pasa el trabajo está en gran medida hecho y su turno se resuelve sin una pausa visible.

El planificador en sí mismo será muy probablemente una forma de GOAP (Planificación de Acciones Orientada a Objetivos): a cada agente se le dan objetivos y un conjunto de acciones disponibles, y un planificador busca una secuencia de acciones que satisfaga un objetivo contra el estado del mundo actual. Esto es un enfoque candidato más que una decisión finalizada.

GOAP encaja bien con la arquitectura existente. La capa de simulación sin asignaciones y de tipo de valor en el sistema de Recursos (sección 2.6) permite al planificador evaluar el resultado de acciones hipotéticas sin asignar ni mutar el estado del juego en vivo, apoyando el objetivo de simulación segura para IA de la sección 2.2.

Los conjuntos de objetivos y acciones, el modelo de costes del planificador y exactamente qué trabajo se almacena en caché durante el turno del jugador están aún por diseñar.

# 4. Referencias

- Reflex: [https://github.com/gustavopsantos/Reflex](https://github.com/gustavopsantos/Reflex)
    
- UniTask: [https://github.com/Cysharp/UniTask](https://github.com/Cysharp/UniTask)
    
- Articy: [https://www.articy.com/en/](https://www.articy.com/en/)
    
- FMOD: [https://fmod.com](https://fmod.com)
    