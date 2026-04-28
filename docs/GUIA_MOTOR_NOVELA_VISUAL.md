# Guia del motor de novela visual

IMPURO funciona ahora como un libro horizontal de tres paneles por escena:

1. `Relato`: personaje, narracion y contexto.
2. `Decision`: pregunta con opciones y bitacora.
3. `Archivo`: iframe local del evento historico e iframe local del personaje.

El cierre final tambien usa tres paneles:

1. `Resultado`
2. `Respuestas`
3. `Orden historico`

## Archivos principales

- `index.html`: punto de entrada.
- `src/scripts/app.js`: logica, maquina de estados, navegacion lateral, feedback y cierre.
- `src/styles/styles.css`: layout horizontal, responsividad y animaciones.
- `src/data/game-config.json`: contenido historico, perfiles de personajes y referencias.

## Maquina de estados

Estados actuales:

- `intro`
- `play`
- `feedback`
- `end`

Reglas:

- Solo se puede responder en `play`.
- El feedback se muestra en `feedback`.
- El cierre final se muestra en `end`.
- La navegacion lateral entre paneles no cambia el estado narrativo; solo cambia la pagina visible del libro.

## Navegacion del libro

-Interaccion por medio de flechas por entrada de teclado
-Flecha izquierda anterior
-Flecha derecha siguiente
-Arriba y abajo desplazamiento entre opciones en sección de preguntas
-Barra espaciadora para seleccionar

## Archivo historico e iframes

La version actual usa iframes locales con `srcdoc` para mostrar:

- Resumen del evento historico del panel actual.
- Perfil del personaje protagonista.
- Orden historico completo en el cierre.

Nota:
No se incrusta Wikipedia directamente porque muchos sitios externos bloquean `iframe` cross-origin. Por eso el juego muestra una lectura local y un enlace externo al articulo de referencia.

## Como agregar una escena

Cada escena debe mantener:

- `characterId` - La cual relaciona personaje con su imagen
- `year`        - Año de acontecimiento   
- `location`    - Ubicación  
- `eventTitle`  - Titulo del evento historico
- `narration`   - Narracion del evento historico
- `historicalContext` - Contexto historico
- `characterLink` - Referencia al personaje
- `wikiUrl`     - Enlace a referencia historica
- `question`    - Preguntas

Si agregas un personaje nuevo, tambien debes crear su perfil en `characterProfiles`.

## Documentos complementarios

- `docs/SONIDOS.md`

