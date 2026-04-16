Config.history.controls = false;
Config.history.maxStates = 1;

setup.impuro = setup.impuro || {};
setup.impuro.loadLock = LoadScreen.lock();
setup.impuro.pendingRoot = null;

setup.impuro.mount = function () {
  const root = setup.impuro.pendingRoot;
  if (!root || !window.ImpuroGame) {
    return;
  }

  window.ImpuroGame
    .mount(root, {
      runtime: window.ImpuroGame.RUNTIME.TWINE,
      onFinish: function (summary) {
        State.variables.impuroScore = summary.score;
        State.variables.impuroCorrect = summary.correctAnswers;
        State.variables.impuroRank = summary.ranking ? summary.ranking.title : "Ruta completada";
      }
    })
    .catch(function (error) {
      console.error("IMPURO: fallo el montaje en Twine.", error);
    });
};

setup.impuro.resourcesReady = Promise.all([
  importStyles("src/styles/styles.css"),
  importScripts("src/scripts/app.js")
])
  .then(function () {
    LoadScreen.unlock(setup.impuro.loadLock);
    setup.impuro.mount();
  })
  .catch(function (error) {
    console.error("IMPURO: no se pudieron cargar los recursos externos.", error);
    LoadScreen.unlock(setup.impuro.loadLock);
  });

$(document).on(":passagedisplay", function (event) {
  if (event.detail.passage.name !== "Start") {
    return;
  }

  setup.impuro.pendingRoot = event.detail.content.querySelector("[data-impuro-root]");
  setup.impuro.resourcesReady.then(function () {
    setup.impuro.mount();
  });
});
