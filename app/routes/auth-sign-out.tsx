import { redirect } from "react-router";

import type { Route } from "./+types/auth-sign-out";
import {
  clearSessionCookie,
  revokeRequestSession,
} from "~/server/auth/session.server";
import { getRequestDatabase } from "~/server/context.server";

export async function action({ context, request }: Route.ActionArgs) {
  await revokeRequestSession(getRequestDatabase(context), request);

  throw redirect("/auth/sign-in", {
    headers: { "Set-Cookie": await clearSessionCookie() },
  });
}

export function loader() {
  throw redirect("/");
}
