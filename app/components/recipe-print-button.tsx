import { Printer } from "lucide-react";

type PrintTarget = Pick<Window, "print">;

export function requestRecipePrint(printTarget: PrintTarget = window) {
  printTarget.print();
}

export function RecipePrintButton() {
  return (
    <button
      aria-label="Print recipe"
      className="icon-button"
      onClick={() => requestRecipePrint()}
      title="Print recipe"
      type="button"
    >
      <Printer aria-hidden="true" size={18} />
    </button>
  );
}
