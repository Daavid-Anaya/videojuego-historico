# Sonidos del juego (requisitos unificados)

Este documento define los sonidos que realmente usa el motor en `src/scripts/app.js` y los nombres actualmente declarados en `src/data/game-config.json`.

Ruta base de audio: `src/audio/`

## 1) Efectos de evento (SFX)

El motor dispara estos eventos:

- `ui.start`
- `ui.menu.open`
- `ui.menu.close`
- `ui.story.open`
- `ui.story.close`
- `ui.page.turn`
- `ui.choice.correct`
- `ui.choice.incorrect`
- `scene.advance`
- `ending.reveal`

En la configuracion actual (`sounds.events`) se mapean a estos archivos:

- `ui.start` -> `ui_button_start.wav`
- `ui.menu.open` -> `modal_open.wav`
- `ui.menu.close` -> `modal_close.wav`
- `ui.story.open` -> `story_open.wav`
- `ui.story.close` -> `story_close.wav`
- `ui.page.turn` -> `scene_page_turn.wav`
- `ui.choice.correct` -> `action_success.wav`
- `ui.choice.incorrect` -> `action_fail.wav`
- `scene.advance` -> `scene_page_turn.wav` (reutiliza el mismo archivo que `ui.page.turn`)
- `ending.reveal` -> `ending_reveal.wav`

## 2) Musica de fondo

### 2.1 Intro y cierre

- Menu de inicio (`sounds.background.menu`): `menu_theme.mp3`
- Pantalla final (`sounds.background.ending`): `end_game_complete.mp3`

### 2.2 Escenas narrativas

Las 10 escenas definidas en `scenes[]` tienen `theme` explicito:

- `scene_1_allende.mp3`
- `scene_2_hidalgo.mp3`
- `scene_3_allende.mp3`
- `scene_4_hidalgo.mp3`
- `scene_5_morelos.mp3`
- `scene_6_allende.mp3`
- `scene_7_hidalgo.mp3`
- `scene_8_morelos.mp3`
- `scene_9_morelos.mp3`
- `scene_10_morelos.mp3`

### 2.3 Evaluacion final (finale.questions)

Las preguntas finales no traen `theme` propio. En ese caso `app.js` genera el nombre automaticamente con este patron:

- `scene_<numero>_<personaje>.mp3`

Con la configuracion actual (presentador: Jose Maria Morelos y Pavon, 3 preguntas finales), el motor intentara cargar:

- `scene_11_jose_maria_morelos_y_pavon.mp3`
- `scene_12_jose_maria_morelos_y_pavon.mp3`
- `scene_13_jose_maria_morelos_y_pavon.mp3`

Si no existen, el juego sigue funcionando, pero no habra musica en esos tramos.

## 3) Paquete de audio requerido

Archivos unicos requeridos por `game-config.json` y `app.js`:

- `menu_theme.mp3`
- `end_game_complete.mp3`
- `ui_button_start.wav`
- `modal_open.wav`
- `modal_close.wav`
- `story_open.wav`
- `story_close.wav`
- `scene_page_turn.wav`
- `action_success.wav`
- `action_fail.wav`
- `ending_reveal.wav`
- `scene_1_allende.mp3`
- `scene_2_hidalgo.mp3`
- `scene_3_allende.mp3`
- `scene_4_hidalgo.mp3`
- `scene_5_morelos.mp3`
- `scene_6_allende.mp3`
- `scene_7_hidalgo.mp3`
- `scene_8_morelos.mp3`
- `scene_9_morelos.mp3`
- `scene_10_morelos.mp3`
- `scene_11_jose_maria_morelos_y_pavon.mp3` (si se quiere musica en evaluacion I)
- `scene_12_jose_maria_morelos_y_pavon.mp3` (si se quiere musica en evaluacion II)
- `scene_13_jose_maria_morelos_y_pavon.mp3` (si se quiere musica en evaluacion III)

Total: 24 archivos (21 obligatorios por config actual + 3 para cubrir fallback del finale).

## 4) Estado actual del repositorio

Actualmente en `src/audio/` solo existe:

- `menu_theme.mp3`

Faltan los demas archivos listados arriba para una experiencia sonora completa.

## 5) Activacion y comportamiento real

- El juego inicia con sonido apagado por defecto (`this.audio.enabled = false` en `app.js`).
- El boton `Sonido: activado/desactivado` es quien habilita o deshabilita audio durante la partida.
- El valor `sounds.enabled` en `game-config.json` no fuerza audio activo al inicio con la implementacion actual.

## 6) Recomendacion para evitar inconsistencias

Para no depender del nombre autogenerado en el finale, agregar `theme` explicito en cada objeto de `finale.questions` (por ejemplo `finale_1.mp3`, `finale_2.mp3`, `finale_3.mp3`) y documentar esos nombres aqui.
