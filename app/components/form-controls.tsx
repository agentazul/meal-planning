import { LoaderCircle } from "lucide-react";
import { useNavigation } from "react-router";

type FieldProps = Readonly<{
  children: React.ReactNode;
  help?: string;
  htmlFor: string;
  label: string;
}>;

export function matchesPendingSubmission(
  formData: FormData | undefined,
  pendingMatch: Readonly<Record<string, string>> | undefined,
): boolean {
  return pendingMatch
    ? Object.entries(pendingMatch).every(
        ([name, value]) => formData?.get(name) === value,
      )
    : true;
}

export function Field({ children, help, htmlFor, label }: FieldProps) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {help ? <span className="field-help">{help}</span> : null}
    </label>
  );
}

export function FormError({ children }: { children?: React.ReactNode }) {
  return children ? (
    <div className="form-error" role="alert">
      {children}
    </div>
  ) : null;
}

export function SubmitButton({
  className = "button button-primary",
  children,
  pendingLabel = "Saving",
  pendingMatch,
}: Readonly<{
  className?: string;
  children: React.ReactNode;
  pendingLabel?: string;
  pendingMatch?: Readonly<Record<string, string>>;
}>) {
  const navigation = useNavigation();
  const matchesSubmission = matchesPendingSubmission(
    navigation.formData,
    pendingMatch,
  );
  const pending = navigation.state !== "idle" && matchesSubmission;

  return (
    <button
      aria-busy={pending || undefined}
      className={className}
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" size={17} />
      ) : null}
      {pending ? pendingLabel : children}
    </button>
  );
}
