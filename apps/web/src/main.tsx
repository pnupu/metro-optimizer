import { RouterProvider, createRouter } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";
import { toast } from "sonner";
import { registerSW } from "virtual:pwa-register";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// The service worker serves the cached app first, so a new deploy runs only after a reload.
// Look for a new deploy at start and each time the app comes back to the screen (a phone can
// keep it open for days). A reload clears the chosen trip and the walkthrough: reload by itself
// only before the first input, else ask (again each time the app comes back, until reloaded).
// lean: every JS chunk loads at start, so the old page keeps working after the new worker
// removes the old precache. Revisit if a chunk is loaded later (a lazy route or import()).
let used = false;
let stale = false;
for (const type of ["pointerdown", "keydown", "wheel"]) {
  addEventListener(type, () => (used = true), { capture: true, once: true, passive: true });
}
const ask = () =>
  toast("A new version of the app is ready.", {
    id: "app-update",
    duration: Infinity,
    action: { label: "Reload", onClick: () => location.reload() },
  });
registerSW({
  immediate: true,
  onNeedReload() {
    stale = true;
    if (used) ask();
    else location.reload();
  },
  onRegisteredSW(_url, registration) {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (stale) ask();
      // Offline (as in a metro tunnel) the check fails: try again the next time.
      else registration?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", check);
    addEventListener("online", check);
  },
  onRegisterError: (error) => console.error("Service worker registration failed", error),
});

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<RouterProvider router={router} />);
}
