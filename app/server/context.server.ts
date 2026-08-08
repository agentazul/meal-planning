import { createContext, redirect, type RouterContextProvider } from "react-router";

import type { Database, RequestDatabase } from "~/db/request-db.server";

const householdScopeBrand: unique symbol = Symbol("household-scope");

export type SessionIdentity = Readonly<{
  email: string;
  householdId: string;
  householdName: string;
  householdTimezone: string;
  userId: string;
  userName: string;
}>;

export type HouseholdScope = Readonly<{
  householdId: string;
  userId: string;
  [householdScopeBrand]: true;
}>;

export type ScopedDatabase = Readonly<{
  db: Database;
  scope: HouseholdScope;
}>;

export const databaseContext = createContext<RequestDatabase>();
export const identityContext = createContext<SessionIdentity | null>(null);
export const householdScopeContext = createContext<HouseholdScope | null>(null);

export function setIdentityContext(
  context: Readonly<RouterContextProvider>,
  identity: SessionIdentity | null,
): void {
  context.set(identityContext, identity);

  if (identity) {
    context.set(householdScopeContext, {
      householdId: identity.householdId,
      userId: identity.userId,
      [householdScopeBrand]: true,
    });
  }
}

export function requireIdentity(
  context: Readonly<RouterContextProvider>,
): SessionIdentity {
  const identity = context.get(identityContext);

  if (!identity) {
    throw redirect("/auth/sign-in");
  }

  return identity;
}

export function requireScopedDatabase(
  context: Readonly<RouterContextProvider>,
): ScopedDatabase {
  const scope = context.get(householdScopeContext);

  if (!scope) {
    throw redirect("/auth/sign-in");
  }

  return {
    db: context.get(databaseContext).db,
    scope,
  };
}

export function getRequestDatabase(
  context: Readonly<RouterContextProvider>,
): Database {
  return context.get(databaseContext).db;
}
