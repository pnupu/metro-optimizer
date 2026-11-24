import { Toaster } from "@metro-optimizer/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      { title: "Metro Optimizer · Helsinki trip planner" },
      {
        name: "description",
        content:
          "Helsinki trip planner that shows which metro entrance to use, the stairs, escalators and elevators, and which end of the train to board.",
      },
    ],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey="theme"
      >
        <Outlet />
        <Toaster richColors />
      </ThemeProvider>
    </>
  );
}
