import { Outlet } from "react-router";

import type { Route } from "./+types/app-layout";
import { AppShell } from "~/components/app-shell";
import { requireIdentity } from "~/server/context.server";

export function loader({ context }: Route.LoaderArgs) {
  return requireIdentity(context);
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell
      householdName={loaderData.householdName}
      userName={loaderData.userName}
    >
      <Outlet />
    </AppShell>
  );
}
