'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormData) => {
    setError('');

    const result = await signIn('credentials', {
      email: data.email,
      password: data.password,
      redirect: false,
    });

    if (result?.error) {
      setError('Invalid email or password. Please try again.');
    } else {
      router.push(callbackUrl);
      router.refresh();
    }
  };

  return (
    <>
      {error && (
        <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-[#EEECE8]">
            Email
          </label>
          <input
            id="email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            autoFocus
            {...register('email')}
            className="flex h-11 w-full rounded-xl border border-[#2E2C2A] bg-[#252422] px-4 text-sm text-[#EEECE8] placeholder:text-[#78756F] transition-colors focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
          />
          {errors.email && (
            <p className="text-sm text-red-400">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium text-[#EEECE8]">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter your password"
              autoComplete="current-password"
              {...register('password')}
              className="flex h-11 w-full rounded-xl border border-[#2E2C2A] bg-[#252422] px-4 pr-10 text-sm text-[#EEECE8] placeholder:text-[#78756F] transition-colors focus:border-[#FF4C29] focus:outline-none focus:ring-2 focus:ring-[#FF4C29]/20"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#78756F] hover:text-[#EEECE8] transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password && (
            <p className="text-sm text-red-400">{errors.password.message}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex h-11 w-full items-center justify-center rounded-xl bg-[#FF4C29] text-sm font-semibold text-white transition-all hover:bg-[#E63E1C] hover:shadow-[0_0_20px_-5px_rgba(255,76,41,0.4)] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Signing in...
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
    </>
  );
}
