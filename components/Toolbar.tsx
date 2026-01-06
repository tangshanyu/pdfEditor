import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', active, ...props }, ref) => {
    const variants = {
      primary: 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm border-transparent',
      secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200 shadow-sm',
      danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm border-transparent',
      ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
    };

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-10 px-4 text-sm',
      lg: 'h-12 px-6 text-base',
    };

    return (
      <button
        ref={ref}
        className={twMerge(
          'inline-flex items-center justify-center font-medium transition-colors rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 border disabled:opacity-50 disabled:cursor-not-allowed',
          variants[variant],
          sizes[size],
          active && 'ring-2 ring-blue-500 bg-blue-50 text-blue-700 border-blue-200',
          className
        )}
        {...props}
      />
    );
  }
);