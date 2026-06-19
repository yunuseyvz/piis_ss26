/**
 * Small loading indicators used across FlowQuest React surfaces.
 */

interface SpinnerProps {
  label?: string;
  inline?: boolean;
}

export function Spinner({ label = 'Loading…', inline = false }: SpinnerProps): JSX.Element {
  const dots = (
    <>
      <span className="flowquest-spinnerDot" />
      <span className="flowquest-spinnerDot" />
      <span className="flowquest-spinnerDot" />
    </>
  );
  if (inline) {
    return (
      <span className="flowquest-spinnerInline">
        {dots}
        <span>{label}</span>
      </span>
    );
  }
  return (
    <div className="flowquest-thinking" role="status" aria-live="polite">
      <span className="flowquest-thinkingSpinner" />
      <span>{label}</span>
    </div>
  );
}
