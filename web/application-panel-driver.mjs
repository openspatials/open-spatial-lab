export function panelDriver(readers, owners) {
  const {
    panelTruthChromeController,
    storefrontShoppingController,
    boardingJourneyController,
    runtimeTweakController,
    semanticDestinationsController,
  } = owners;
  const $ = readers.lookup;
  return {
    wowApi: panelTruthChromeController.wowApiDriver(),
    panelGroups: panelTruthChromeController.groupDriver(),
    chrome: panelTruthChromeController.chromeDriver(),
    storefrontShopping: storefrontShoppingController.driver(),
    airportBoarding: boardingJourneyController.driver(),
    runtimeTweaks: runtimeTweakController
      ? {
          open: () => runtimeTweakController.open(),
          close: () => runtimeTweakController.close(),
          set: (key, value) => runtimeTweakController.setValue(key, value),
          reset: (key) => runtimeTweakController.resetValue(key),
          resetAll: () => runtimeTweakController.resetAll(),
          copyRow: (key) => runtimeTweakController.copyRow(key),
          copyAll: () => runtimeTweakController.copyAll(),
          resizeTo: (width, height) =>
            runtimeTweakController.resizeTo(width, height),
          snapshot: () => runtimeTweakController.snapshot(),
          setClipboardWriterForTest: (writer) =>
            runtimeTweakController.setClipboardWriterForTest(writer),
        }
      : null,
    returnLobbyButtonState: () => {
      const btn = $("btn-return-lobby");
      return btn
        ? {
            hidden: btn.hidden === true,
            disabled: btn.disabled === true,
            title: btn.getAttribute("title"),
            aria_label: btn.getAttribute("aria-label"),
          }
        : null;
    },
    semanticDestinations: {
      open: () => semanticDestinationsController.open(),
      close: () => semanticDestinationsController.close(),
      activate: (key) => semanticDestinationsController.activate(key),
      snapshot: () => semanticDestinationsController.snapshot(),
    },
  };
}
