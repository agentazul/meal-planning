import { CalendarDays, CookingPot, LogOut, Sprout } from "lucide-react";
import { Form, Link, NavLink } from "react-router";

type AppShellProps = Readonly<{
  children: React.ReactNode;
  householdName: string;
  userName: string;
}>;

const navigation = [
  { to: "/", label: "Week", icon: CalendarDays, end: true },
  { to: "/recipes", label: "Recipes", icon: CookingPot, end: false },
  { to: "/presence", label: "Presence", icon: Sprout, end: false },
] as const;

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  return navigation.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      className="nav-link"
      end={end}
      key={to}
      to={to}
    >
      <Icon aria-hidden="true" size={mobile ? 20 : 17} strokeWidth={2} />
      <span>{label}</span>
    </NavLink>
  ));
}

export function AppShell({
  children,
  householdName,
  userName,
}: AppShellProps) {
  return (
    <div className="app-frame">
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true">
              <Sprout size={22} strokeWidth={1.8} />
            </span>
            <span>
              <span className="brand-name">Kitchen Ledger</span>
              <span className="brand-caption">Plan what carries forward</span>
            </span>
          </Link>

          <nav className="desktop-nav" aria-label="Primary navigation">
            <NavigationLinks />
          </nav>

          <div className="account-chip">
            <span className="account-copy">
              <span className="account-name">{userName}</span>
              <span className="account-household">{householdName}</span>
            </span>
            <Form action="/auth/sign-out" method="post">
              <button className="icon-button" type="submit" aria-label="Sign out">
                <LogOut aria-hidden="true" size={17} />
              </button>
            </Form>
          </div>

          <Form action="/auth/sign-out" className="mobile-sign-out" method="post">
            <button
              aria-label="Sign out"
              className="icon-button"
              title="Sign out"
              type="submit"
            >
              <LogOut aria-hidden="true" size={18} />
            </button>
          </Form>
        </div>
      </header>

      <main className="app-main">{children}</main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        <NavigationLinks mobile />
      </nav>
    </div>
  );
}
