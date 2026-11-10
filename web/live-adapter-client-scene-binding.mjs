import { createClientSceneLifecycleController } from "./live-adapter-client-scene-controller.mjs";

export function bindClientScene({ presence, log, commitVisualTransition, dispatchCrossing, ...capabilities }) {
  return createClientSceneLifecycleController({
    ...capabilities,
    presence: {
      ...presence,
      registerPresence(input) {
        const registration = presence.registerPresence(input);
        // Local reciprocal return releases rendering without waiting for network registration.
        if (input && input.spawnReason === "return_from_client_scene_load") {
          void registration.catch(error => log(
            `return presence registration continued after visual commit and failed: ${error.message}`,
          ));
          return undefined;
        }
        return registration;
      },
    },
    dispatchCrossing(detail) {
      commitVisualTransition();
      dispatchCrossing(detail);
    },
  });
}
