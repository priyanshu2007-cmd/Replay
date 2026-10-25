import { forwardRef, useId } from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className = '', id: idProp, ...props },
  ref,
) {
  const id = useId();
  const inputId = idProp ?? id;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="flex w-full flex-col gap-2">
      <label htmlFor={inputId} className="text-[13px] font-medium text-primary">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-describedby={errorId ?? hintId}
        aria-invalid={error ? true : undefined}
        className={`h-9 w-full rounded-s border bg-panel px-3 text-[14px] text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          error ? 'border-fail-fill' : 'border-border-subtle'
        } ${className}`}
        {...props}
      />
      {hint && !error && (
        <p id={hintId} className="text-[12px] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-[12px] text-fail-text">
          {error}
        </p>
      )}
    </div>
  );
});
