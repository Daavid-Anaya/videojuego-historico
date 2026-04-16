# Integracion con Twine / SugarCube

Estos archivos estan listos para pegar en un proyecto de Twine con formato SugarCube.

## Que pegar y donde

1. `story-javascript.js` -> Story JavaScript
2. `story-stylesheet.css` -> Story Stylesheet
3. `start-passage.txt` -> pasaje `Start`

## Requisitos

- Mantener el HTML exportado de Twine en la misma raiz del proyecto o servirlo desde alli.
- Ejecutar la historia con servidor local para que SugarCube pueda cargar:
  - `src/data/game-config.js`
  - `src/scripts/app.js`
  - `src/styles/styles.css`

## Variables que Twine recibira al terminar

- `$impuroScore`
- `$impuroCorrect`
- `$impuroRank`

## Nota

El juego ya muestra su propio cierre y repaso dentro del motor. Las variables de Twine quedan disponibles si despues quieres desbloquear un pasaje adicional de creditos o recompensas.
