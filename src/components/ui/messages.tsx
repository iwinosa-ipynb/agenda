export function FormError({ message }: { message?: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
    >
      {message}
    </div>
  );
}

export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div
      role="status"
      className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-2.5 text-sm text-accent-strong"
    >
      {message}
    </div>
  );
}
