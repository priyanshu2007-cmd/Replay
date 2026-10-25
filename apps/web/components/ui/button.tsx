import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90',
  secondary: 'bg-raised text-primary border border-border-subtle hover:border-border-strong',
  ghost: 'text-secondary hover:text-primary hover:border-border-subtle border border-transparent',
  destructive: 'bg-fail-fill text-white hover:opacity-90',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`inline-flex h-9 min-w-[44px] items-center justify-center gap-2 rounded-s px-3 text-[13px] font-medium transition-[transform,opacity,border-color,background-color] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
});
