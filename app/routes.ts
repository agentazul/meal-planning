import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  route("auth/sign-in", "routes/auth-sign-in.tsx"),
  route("auth/verify", "routes/auth-verify.tsx"),
  route("auth/sign-out", "routes/auth-sign-out.tsx"),
  layout("routes/app-layout.tsx", [
    index("routes/week.tsx"),
    route("pantry", "routes/pantry.tsx"),
    route("preferences", "routes/preferences.tsx"),
    route("presence", "routes/presence.tsx"),
    route("plans/:weekStart/generate", "routes/plan-generate.tsx"),
    route("recipes", "routes/recipes.tsx"),
    route("recipes/generate", "routes/recipe-generate.tsx"),
    route("recipes/new", "routes/recipe-new.tsx"),
    route("recipes/:recipeId", "routes/recipe-detail.tsx"),
  ]),
] satisfies RouteConfig;
