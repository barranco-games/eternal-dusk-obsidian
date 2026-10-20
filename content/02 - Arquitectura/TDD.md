**  

DOCUMENTO DE DISEÑO TÉCNICO

Eternal Dusk

A party-based cosmic-horror investigation CRPG

|   |   |
|---|---|
|Estudio / Equipo|Barranco Games|
|Autor(es)|Sergio Marchena, Carlos Márquez|
|Última actualización|Octubre 2026|
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
    
- La sangría usa tabulaciones. Las llaves siguen el estilo Allman, con cada llave en su propia línea. Los archivos no terminan con un salto de línea final (un analizador lo marca).
    
- Los namespaces tienen ámbito de bloque y reflejan la arquitectura, `EternalDusk.<Layer>.<Area>` (por ejemplo EternalDusk.Systems.UI.Dialogue). El primer segmento después de la raíz es siempre la capa.
    
- Un tipo principal por archivo. Un pequeño tipo auxiliar estrechamente relacionado (un enum o struct de apoyo) puede compartir el archivo.
    
- Cada archivo se abre con el comentario de encabezado estándar, insertado por las plantillas de script del proyecto (Assets > Create > Custom Script, con las plantillas en Assets/Editor/ScriptTemplates), y no se escribe a mano:
    

|   |
|---|
|/*<br><br>**  LevelContext<br><br>**<br><br>**  Created by <Author> on <dd/mm/yyyy><br><br>**  Copyright© <year>, Barranco Games. All rights reserved.<br><br>*/|

  

### Usings

Las directivas using se agrupan en un orden fijo, separadas por líneas en blanco: primero los namespaces de System, luego Unity, luego de terceros (como Reflex), luego los propios namespaces de EternalDusk del proyecto ordenados por capa de Core hacia afuera. Un analizador marca cualquier using fuera de este orden.

|   |
|---|
|using System;<br><br>using System.Collections.Generic;<br><br>using UnityEngine;<br><br>  <br><br>using Cysharp.Threading.Tasks;<br><br>using Reflex.Attributes;<br><br>using EternalDusk.Core.Persistence;<br><br>using EternalDusk.Systems.UI;<br><br>using EternalDusk.Engine.World;|

  

### Nomenclatura

- Los tipos, métodos, propiedades, eventos y constantes usan PascalCase. Las interfaces llevan el prefijo I (IDialogueView, IGameStateService).
    
- Los campos privados usan un guión bajo inicial y camelCase (_choiceButtons, _awaitingChoice); las variables locales y los parámetros son camelCase.
    
- Las constantes son PascalCase, no upper-snake-case (ChunkSize, SkillMaxRange).
    
- Los sufijos de rol se usan de forma consistente: View, Presenter, Service, Installer, Context, Manager, Factory, Registry, Provider, Builder.
    
- Los sufijos de datos tienen significado: Data para snapshots de valor serializables (TransformData), Definition para datos de ScriptableObject editados, y State para el estado de guardado.
    

### Variables y campos

- Los campos son explícitamente private, y readonly siempre que no se reasignen.
    
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
    
- Los MonoBehaviours reciben las referencias de Unity mediante [SerializeField] y los servicios mediante [Inject]; los tipos que usan inyección por campo son [SourceGeneratorInjectable] y partial. Las clases simples usan inyección por constructor.
    

### Registro (logging)

- Todo el registro pasa por la fachada estática Log en EternalDusk.Core.Logging, que reenvía a una implementación ILogger: EDLogger en tiempo de ejecución, NullLogger por defecto. Nunca llamar directamente a Debug.Log o Debug.LogFormat; un analizador lo marca y apunta al equivalente Log.
    
- Los niveles son Error, Warn, Info y Verbose (LogLevel), más None para silenciarlo todo. Se omiten los mensajes menos graves que el nivel activo.
    
- Cuando un mensaje es costoso de construir (interpolación o concatenación de strings), usar la sobrecarga Func<string> para que solo se evalúe cuando el nivel está activo: Log.Warn(() => $"..."). Un analizador marca los mensajes que puntúa como costosos pasados a la sobrecarga de string simple, y la prueba LazyLoggingTests detecta el resto. Los mensajes constantes o baratos pueden usar la sobrecarga de string directamente.
    

### Disciplina de asignación

- Mantener las rutas críticas sin asignaciones: cachear delegados, reutilizar buffers, usar Array.Empty<T>() por defecto, y evitar LINQ y cierres por fotograma (véanse los objetivos técnicos en la sección 2.2). Un analizador marca las asignaciones en el heap, las llamadas LINQ y los delegados creados dentro de métodos por fotograma.
    

### Comentarios

- Escribir los menos comentarios posibles. Usar /// solo para resúmenes de contratos públicos no obvios.
    
- Los comentarios en línea quedan para el código realmente arcano (trucos de bits, algoritmos sutiles). Un comentario de más de una frase indica que el código debe reescribirse.
    

### Pruebas y determinismo

- Las pruebas reflejan las capas: un ensamblado EditMode por capa (EternalDusk.Tests.EditMode.Core, …Gameplay, …Systems, …Engine) más EternalDusk.Tests.PlayMode. Las de EditMode usan el namespace `EternalDusk.Tests.<Layer>.<Area>`.
    
- Una clase de prueba por clase de producción; los métodos se nombran Method_Scenario_Outcome.
    
- Fakes en lugar de frameworks de mocking; los compartidos viven en Tests/EditMode/Common.
    
- La aleatoriedad se inyecta como System.Random; nunca se comprueba un resultado de aleatoriedad sin semilla.
    

## 2.5 Bibliotecas externas

Estas son las bibliotecas de terceros de las que depende el proyecto.

|Biblioteca|Versión|Propósito|Licencia|
|---|---|---|---|
|Reflex|14.3.1|Contenedor de inyección de dependencias utilizado para resolver dependencias en todas las capas.|MIT|
|UniTask|2.5.11|async/await eficiente en asignaciones para Unity; se usa en todas las capas para trabajo distribuido en fotogramas y trabajo asíncrono.|MIT|
|Articy|Draft X|Autoría de narrativa y diálogos; las entidades se enlazan con objetos de Articy y poseen conversaciones.|Propietario|
|FMOD|2.03.14|Middleware de audio para música adaptativa y efectos de sonido, integrado a través de la capa Engine.|Propietario|
|Odin Inspector|4.0.2.3|Atributos de inspector (BoxGroup, etc.) y drawers de editor para los componentes y assets de la capa Engine; las capas internas no lo usan.|Propietario|

  

El proyecto también depende de paquetes oficiales de Unity distribuidos a través del Package Manager: el Universal Render Pipeline (URP 17.5), el Input System (gestión de entrada), Cinemachine 3 (cámara), AI Navigation (NavMesh), Addressables, Localization (tablas de inglés y español), Mathematics, Newtonsoft Json (serialización de partidas) y Test Framework con Code Coverage, junto con el Job System, Burst y los compute shaders utilizados por la capa Engine. La UI se construye con UI Toolkit. Estas son tecnologías propias de Unity más que dependencias de terceros.

## 2.6 Visión general de la organización del código

Esta sección describe cómo está estructurado el código: la arquitectura por capas, el modelo de entidad sobre el que se construyen la mayoría de los objetos del juego y los sistemas principales (en las subsecciones que siguen).

### Arquitectura y capas

El código está dividido en cuatro capas. Ordenadas de la más interna a la más externa son Core, Gameplay, Systems, y Engine. Las dependencias apuntan hacia adentro: una capa puede usar las capas interiores pero nunca las exteriores, y Core no depende de nada más que de sí misma. Cada capa es un ensamblado (EternalDusk.Core, EternalDusk.Gameplay, EternalDusk.Systems, EternalDusk.Engine), y los tres internos se compilan con noEngineReferences, así que una referencia a Unity en ellos no compila. Solo Engine referencia Unity y plugins de terceros; las únicas excepciones son UniTask, permitido en todas las capas, y Reflex, permitido desde Gameplay hacia afuera. Las dependencias se conectan a través de Reflex.

- Core: primitivas y contratos independientes del motor, incluyendo identificadores como EntityId y PrefabId, datos de tipo de valor y los buses unificados (por ejemplo StatType y ResourceType). C# puro, y el código más sensible al rendimiento.
    
- Gameplay: reglas del juego y definiciones construidas sobre Core, incluyendo las categorías de estadísticas concretas (atributos, combate, derivadas, aptitudes, resistencias) con el mediador de estadísticas (StatsMediator) y sus modificadores (StatsModifier), tipos de daño, efectos de estado y tipos de recursos como Health, ActionPoints, Ammunition y Sanity.
    
- Systems: servicios que coordinan el juego, incluyendo las hojas de estadísticas por actor (ActorStats, AgentStats), el caché del estado de los recursos (ActorResources), las acciones (MovementService, SkillService, DialogueService), los turnos, la IA enemiga y su simulación, el pipeline de áreas, los presentadores de UI y la orquestación de guardar/restaurar (GameStateService).
    
- Engine: la única capa consciente de Unity y los plugins, con entidades MonoBehaviour, shaders de renderizado y cómputo, entrada, integración de Articy y FMOD, y los adaptadores que vinculan los sistemas internos al entorno de ejecución.
    
- Fuera de las capas: los compute shaders, el HLSL y los render features (SelectionOutlineFeature) viven en Assets/Scripts/Shaders, dentro de Assembly-CSharp y sin asmdef; las herramientas de editor, en EternalDusk.Editor; y las pruebas, en ensamblados que reflejan las capas (véase 2.4).
    

Un pilar central de esta estructura es un juego de alto rendimiento: con las capas internas independientes del motor y sin alocaciones, la lógica más frecuentemente ejecutada se mantiene rápida, mientras que la capa Engine absorbe todo lo específico de Unity.

### Modelo de entidad

Todo lo que el jugador puede interactuar es una Entity. Las entidades viven en la capa Engine como MonoBehaviour y forman una jerarquía de tres niveles de capacidad creciente.

|Tipo|Representa|Añade|
|---|---|---|
|Entity<TState>|Cualquier cosa con la que se puede interactuar en el mundo.|EntityId y PrefabId estables, posición en el mundo con un evento de cambio basado en push, guardado/restauración versionado, selección/resaltado y enlace con Articy.|
|Actor<TState, TStats, TDefinition>|Una entidad con salud y comportamiento más rico.|Resources, Stats (con sus Resistances), Health y un controlador de efectos de estado; hook de inicio de turno (BeginTurn) y ocultación cuando el grupo no lo ve (IConcealable).|
|Agent<TState>|Personas y monstruos.|Habilidades, equipamiento y los recursos de agente puntos de acción, munición y cordura; refresca los PA y avanza los cooldowns cada turno.|

  

Cada Entity<TState> lleva un EntityId y un PrefabId estable, expone su Position en el mundo, y lanza OnPositionChanged solo cuando realmente se mueve, y esta señal basada en push es lo que alimenta los reveladores del Sistema de Áreas. La clase se divide en archivos partial por responsabilidad:

- Core y Persistencia: cada entidad captura y restaura un estado tipado a través de un SaveEnvelope. Version y Migrate permiten que las partidas antiguas se actualicen cuando cambia el formato del archivo de guardado.
    
- Visual e Interacción: el hover, el foco, la fijación de objetivo, la revelación y el parpadeo encienden un contorno, dibujado por SelectionOutlineFeature, marcando bits de la máscara de capas de renderizado de los renderers de la entidad (OutlineLayers); su tono lo resuelve OutlineTint (Neutral, Hostile, Ally, Target, Blink), y la fijación de objetivo (rojo) gana sobre los demás.
    
- Narrativa: las entidades pueden enlazarse a un objeto de Articy y poseer una conversación, conectándose al sistema de diálogo y narrativa.
    

Un Actor es una entidad con salud y comportamiento más complejo: posee Recursos, Estadísticas, Vida, y un controlador de efectos de estado, se inicializa desde una IActorDefinition, y avanza los efectos de estado al inicio de su turno.

Un Agent, es el tipo utilizado para personas y monstruos, añade habilidades, equipamiento y los recursos de agente puntos de acción, munición y cordura; construye su AgentStats (atributos, resistencias, aptitudes, derivadas) desde una definición, y refresca los puntos de acción y los cooldowns de habilidades al inicio de cada turno.

Las clases concretas son PlayerAgent y Enemy (Agent<AgentData>), Item y AmmoPack (Entity<EntityData>) y Weapon (Entity<WeaponData>), además de la base ObstacleActor para obstáculos con salud. Las capas internas no ven estas clases sino sus contratos: IEntity, IEntitySource y EntityId en Core.World, PrefabId en Core.Persistence, IActor en Gameplay.World e IAgent en Systems.World. Las instancias se obtienen con las extensiones de IEntitySource (OfType<T>, TryGetFirst<T>, Single<T>), no con ids fijos en el código.

### Especificaciones de los sistemas

La especificación técnica detallada de cada sistema se mantiene en el capítulo de arquitectura del vault del GDD, que es la fuente única de verdad. Para evitar la duplicación y el riesgo de que este documento quede desactualizado, los sistemas se referencian aquí en lugar de reproducirse. El Sistema de Áreas es el más cercano a su versión final; los demás están en distintas etapas.

- [[Action System]]: controlador de cualquier cosa que una entidad haga durante un periodo de tiempo.
    
- [[Area System]]: consultas espaciales aceleradas por GPU para la niebla de guerra, visión de unidades y fijación de objetivos de habilidades en un mundo amplio y en streaming.
    
- [[Stats System]]: atributos, estadísticas de combate y derivadas, aptitudes y resistencias resueltos a través de un pipeline de modificadores.
    
- [[Resources System]]: recursos acotados (salud, puntos de acción, cordura, munición) con una capa de simulación sin asignaciones para IA y planificación.
    
- [[Save & Load System]]: captura y restauración versionada por entidad, con soporte de migración para formatos de guardado anteriores.
    
- [[Turn System]]: turnos de exploración por reloj y de combate por iniciativa, con turnos de grupo fusionados y una fase del mundo que cierra cada ronda.
    
- [[Combat & Dice]]: tiradas de atributo d100 con niveles de éxito, ventaja y desventaja, probabilidad de acierto y la cadena de daño, sobre un flujo de dados con semilla que se guarda.
    
- [[Status Effects System]]: estados con una ranura por tipo, compuestos de comportamientos definidos en datos, que se descuentan al inicio del turno de su portador.
    
- [[Encounter System]]: encuentros definidos como fases en orden (diálogo, exploración, unión al grupo, combate) y el modo de juego que entra y sale del combate.
    
- [[Party System]]: los agentes que controla el jugador y su líder, cómo se unen, la vista compartida y la regla de hostilidad.
    
- [[Enemy AI]]: planificación del turno enemigo por búsqueda sobre estados simulados, objetivos por agente y conocimiento compartido del grupo dentro de un encuentro.
    
- [[Equipment System]]: lo que lleva cada agente, con un juego de manos cuerpo a cuerpo y otro a distancia, cargadores por arma y la búsqueda del arma que concedió cada habilidad.
    
- [[UI Architecture]]: vistas, presentadores y servicio sobre UI Toolkit, la raíz PanelRenderer y su recarga en vivo, los presentadores del HUD y la localización de los textos.
    
- [[Level & Scene Loading]]: arranque, transiciones de escena, definiciones de nivel y los pasos de ciclo de vida que levantan y cierran cada nivel.
    
- [[Commands & Debugging]]: comandos de texto que ejecutan las acotaciones de Articy y los barks, y las herramientas de depuración (la consola, las teclas F9 y F10, el arnés de escenarios y los drivers de builds).
    
- [[Dialogue System]]: la integración de Articy, de la entidad enlazada a la línea en pantalla, con hablantes y retratos, revelado de texto, barks, métodos de script, variables globales y su guardado, y localización.
    
- [[Camera & Input]]: el rig de Cinemachine 3 (cámara libre, de foco, planos de diálogo y de depuración), el rayo del puntero, las acciones del Input System y los bloqueos de entrada.
    
- [[Quest System]]: seguimiento y progresión de misiones principales y secundarias.
    
- [[Technical Sound Document]]: especificación técnica y artística del audio con FMOD.
    
- Con código pero sin página propia, por ser pequeños: los ajustes de usuario (Core/Settings, Systems/Settings), los servicios de plataforma (reloj de juego, bucle de actualización, pantalla y tasa de fotogramas; Core/Platform, Engine/Unity/Platform) y la pausa (IPauseService, Core/GameState), la analítica y el informe de errores (Engine/Analytics), el perfilado (Core/Profiling, Engine/Profiling) y los VFX de habilidades (Engine/Unity/Vfx).
    

TODO: Un diagrama de arquitectura debe acompañar esta sección.

|   |
|---|
|[ Diagrama de arquitectura ]|

## 2.7 Política de ramas

El modelo de ramas usa ramas de larga duración master y develop con ramas de corta duración para funcionalidades y correcciones ([Representación Visual](https://drive.google.com/file/d/1h5U6k1IXgpsnfa_IcXHHb-gEemEMg2k8/view)). Por norma del equipo, ninguna de las dos ramas largas recibe push directo: todo el trabajo entra por pull request (el repositorio no puede imponerlo con protección de ramas).

### Ramas

- master: la rama estable; cada versión publicada se fusiona aquí (y alguna corrección urgente, con una rama hotfix/…-master).
    
- develop: la rama base y de integración; las pull requests apuntan aquí.
    
- `<tipo>/…`: ramas de corta duración para un solo cambio.
    
- release/x.y.z: lleva develop a master en cada versión (véase 2.10).
    

### Convención de nomenclatura

Las ramas de corta duración siguen este patrón:

|   |
|---|
|`<type>/<branch-name>`|

  

- `<type>`: el tipo de cambio: feature (o feat), fix, perf, refactor, cleanup, chore, ci, test, docs o tooling; hotfix para una corrección urgente a master; release para una versión.
    
- Cuando el cambio sale de una fila del tablero de revisión, el nombre empieza por el id de esa fila (fix/sav-1-autosave-and-dice); las ramas ya no suelen vincularse a issues de GitHub.
    
- `<branch-name>`: un nombre corto, en inglés y kebab-case, que nombra el cambio.
    

Por ejemplo:

|   |
|---|
|feature/prison-cells-start-level<br><br>fix/fog-range-storage-load-race<br><br>release/0.1.5|

  

### Fusiones y comprobaciones

- Las pull requests a develop se fusionan con squash; la de una versión (release/x.y.z a master) y la que devuelve master a develop después se fusionan con un commit de fusión (desde 0.1.5), para que las dos historias no se separen.
    
- Las comprobaciones corren en GitHub Actions sobre un runner autoalojado: Tests (EditMode y PlayMode, con cobertura) en cada pull request no borrador a develop o master y en cada push a esas ramas que cambie Assets (salvo Assets/Art), Packages o ProjectSettings, y cada día sobre develop; Player build en las pull requests a master y en las de develop que cambian lo que compila el reproductor (véase 2.9); Code location en las pull requests a develop y master y en los pushes a master; Agent tooling en pull requests y pushes. El plan del repositorio no admite protección de ramas, así que las comprobaciones son orientativas: Develop gate marca como pendientes las pull requests a develop mientras corre la verificación de una fusión en develop.
    

### Git LFS

Desde el 16/10/2026 los binarios (png, jpg, jpeg, psd, tga, exr, hdr, fbx, ttf, otf, wav, mp3, ogg, bank, bytes) se guardan en Git LFS. Para moverlos se reescribió toda la historia, así que los hashes de commit anteriores a esa fecha no existen en un clon nuevo. El .articyu3d sigue como binario normal de git. Code location rechaza un binario subido sin pasar por LFS (git lfs fsck --pointers). Las escenas, prefabs y assets se fusionan con el driver unityyamlmerge (.gitattributes, Tools/unityyamlmerge.sh).
    

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

### Mediciones (0.1.5, candidata)

La auditoría de rendimiento del 06/10/2026, repetida el 17/10/2026 con el mismo escenario para 0.1.1, 0.1.2 y dos capturas de 0.1.5 (antes y después de la candidata a versión), amplía las capturas del perfilador previas (editor, 27/09; build de jugador, 02/10). Son capturas en el editor sobre DemoArena a 1080p: arranque, diálogo, exploración, saltos de cámara, un combate de tres rondas, guardar y cargar. No sustituyen a las mediciones en el hardware objetivo, pero ya acotan los presupuestos de arriba.

|Métrica|0.1.5 (candidata)|Notas|
|---|---|---|
|CPU del hilo principal, media en juego|~2.1 ms|Frente a los 16.7 ms del presupuesto de fotograma.|
|Fotogramas de juego por encima de 16.7 ms|0|En todas las versiones medidas.|
|Peor porción de planificación de la IA|~0.9 ms|La búsqueda cede el fotograma al gastar TurnPlanner.SliceBudget (1 ms).|

## 2.9 Método de entrega de la build

Las builds se producen de forma automatizada en GitHub Actions, sobre un runner autoalojado en el PC de un miembro del equipo, que solo atiende trabajos mientras su sesión (run.cmd) está abierta. El workflow Player build (.github/workflows/player-build.yml) compila el reproductor de Windows x64 en release con IL2CPP (SmokeBuild.BuildAndExit) y juega en él una partida nueva (-smoke) como prueba de humo. Se dispara en cada push a master, en cada pull request a master, en las pull requests a develop que cambian lo que compila el reproductor, cada lunes sobre develop y a mano. Solo se suben los logs (7 días en pull requests, 30 en el resto); el ejecutable no se publica. Siguen abiertas estas decisiones:

- Las builds de macOS y Linux: hoy solo se compila Windows.
    
- Dónde se entregan y almacenan las builds y en qué formato.
    
- Quién distribuye las builds a jugadores o testers y con qué frecuencia.
    

## 2.10 Lista de versiones TODO:

La hoja de ruta más allá de 0.2.0 aún no está definida; cuando el equipo acuerde los hitos, cada versión planificada y sus funcionalidades objetivo se listan aquí. Desde 0.1.5, una versión se publica fusionando una rama release/x.y.z en master con un commit de fusión que sube bundleVersion (ProjectSettings), y se etiqueta Release_x.y.z; después master vuelve a develop, también con un commit de fusión. Las versiones anteriores se cortaron con squash, con commit directo o, en 0.1.2, también con un commit de fusión.

|Versión|Funcionalidades planificadas|Fecha objetivo|Estado|
|---|---|---|---|
|v0.1.0|Primer prototipo jugable en DemoArena|21/09/2026|Publicada|
|v0.1.1|Iteración del prototipo de DemoArena|28/09/2026|Publicada|
|v0.1.2|Iteración del prototipo de DemoArena|08/10/2026|Publicada|
|v0.1.3|Iteración del prototipo de DemoArena|10/10/2026|Publicada|
|v0.1.4|Iteración del prototipo de DemoArena|10/10/2026|Publicada|
|v0.1.5|Iteración del prototipo de DemoArena: exploración, diálogo con Articy, combate por turnos contra la IA, guardar y cargar|19/10/2026|Publicada (versión actual)|
|v0.2.0|Nivel tutorial de la prisión (Prison_Cells_Start), independiente de DemoArena, que queda solo para depuración|Por definir|En desarrollo|
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

Hoy solo se compila y prueba en CI el reproductor de Windows x64 (IL2CPP); macOS y Linux no tienen todavía build ni prueba automatizada.

# 3. Secciones Adicionales

## 3.1 Elección del motor de juego

El juego está construido en Unity 6 (editor 6000.5.5f1) con el Universal Render Pipeline. El equipo ha trabajado con Unity durante los últimos diez años, por lo que el motor es bien conocido, y su apertura permite al equipo construir los sistemas que el juego necesita en lugar de trabajar alrededor de un framework opinado. Esa flexibilidad es lo que hace posible la arquitectura personalizada y orientada al rendimiento de la sección 2: el Sistema de Áreas impulsado por GPU, la configuración de inyección de dependencias y la organización del código por capas.

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
    
3. Integración en Unity ([Unity Package](https://assetstore.unity.com/packages/tools/fmod-for-unity-2-03-upm-1082237)): Las capas internas interactúan controlando el comportamiento dinámico del audio a través de la inyección de parámetros basados en tipos de valor puro extraídos de los snapshots del juego. Los bancos de sonido se cargan de forma asíncrona al arrancar, uno por fotograma, mediante AudioBankLoader sobre el RuntimeManager de FMOD (los ajustes de FMOD no cargan ningún banco por sí mismos); no pasan por Addressables ni siguen el streaming de chunks del mundo.
    

## 3.3 Objetos 3D, terreno y gestión de escenas

La gestión de assets y escenas utilizará el sistema Addressables de Unity. Addressables carga contenido (prefabs, escenas y otros assets) bajo demanda por dirección en lugar de mediante referencias directas, lo que mantiene la memoria bajo control y desacopla lo que se carga de donde se referencia. Esto se alinea naturalmente con el modelo de entidad, donde cada objeto ya lleva un PrefabId estable (sección 2.6).

La agrupación de assets, la estrategia de carga y cómo Addressables interactúa con la carga de niveles y el streaming del terreno del Sistema de Áreas están aún por detallar.

Hoy Addressables (2.9.1) solo sirve las tablas de Localization: las escenas se cargan por nombre con SceneManager desde la lista de escenas de la build, y los prefabs se resuelven por PrefabId a través de PrefabRegistryDefinition. Cómo se cargan hoy las escenas y los niveles se describe en [[Level & Scene Loading]].

## 3.4 Inteligencia Artificial

La IA más exigente se ejecuta durante el combate, que es por turnos; fuera del combate, el comportamiento del agente es comparativamente ligero. Vive sin dependencias del motor en Systems/AI, detrás de AIService (ITurnPlanSource), y AITurnController ejecuta cada paso del plan con los mismos MovementService y SkillService que usa el jugador. En lugar de calcular durante el turno del jugador, el coste se reparte. Al empezar un encuentro, PrepareEncounter llena un pool de estados simulados (128, a 32 por fotograma) y el primer turno de combate espera a que esté listo. En el turno de la IA, la búsqueda devuelve el fotograma cada vez que una porción gasta TurnPlanner.SliceBudget (1 ms), de modo que un combate grande cuesta más fotogramas, no fotogramas más largos.

El planificador no es GOAP sino una búsqueda en haz best-first sobre estados del mundo simulados (TurnPlanner). Expande el nodo más prometedor, pide acciones candidatas a los proveedores de movimiento y de habilidades, y conserva las mejores ramas (MaxBranches = 6) hasta una profundidad de 8 y 512 expansiones como máximo. Devuelve como plan del turno el camino de mayor puntuación, o ninguno si nada mejora quedarse quieto. Cada paso se puntúa con términos de daño infligido, salud propia, estados aplicados, penalización por muerte, movimiento, consumibles y logro del objetivo. El daño simulado es un valor esperado, ponderado por la probabilidad de impacto, y nunca se tira, así que un plan es determinista.

El planificador encaja con la arquitectura existente. Cada rama trabaja sobre su propia copia de un estado del pool (SimulatedWorldState, SimulatedAgentState, SimulationStatePool), con los recursos guardados como snapshots de valor ResourceState del sistema de Recursos (sección 2.6). Así evalúa acciones hipotéticas sin mutar el estado del juego en vivo y solo asigna cuando el pool se queda corto, como pide el objetivo de simulación segura para IA de la sección 2.2.

Los objetivos se editan por agente en AgentDefinitionSO como AIGoalData (prioridad y un multiplicador por término de puntuación). GoalSelector juega el de mayor prioridad disponible; sin objetivos editados, el agente juega KillTarget, que hoy es el único AIGoalKind. Para el grupo, es hostil cualquier IEntity que no esté en él y no sea neutral (PartyServiceExtensions.AreHostile), y los enemigos de un encuentro comparten lo que ven del grupo hasta que acaba. Quedan por diseñar más tipos de objetivo, las facciones y el disparador de aggro fuera de los encuentros guionizados.

La especificación completa está en [[Enemy AI]].

# 4. Referencias

- Reflex: [https://github.com/gustavopsantos/Reflex](https://github.com/gustavopsantos/Reflex)
    
- UniTask: [https://github.com/Cysharp/UniTask](https://github.com/Cysharp/UniTask)
    
- Articy: [https://www.articy.com/en/](https://www.articy.com/en/)
    
- FMOD: [https://fmod.com](https://fmod.com)
    