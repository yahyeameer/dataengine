'use client';

import Link from 'next/link';
import { motion, useMotionValue, useTransform, useSpring } from 'framer-motion';
import { AuthForm } from '@/components/auth-form';
import { ProductStory } from '@/components/product-story';
import { Shield, Sparkles, Lock, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const rotateX = useSpring(useTransform(mouseY, [-300, 300], [6, -6]), { stiffness: 120, damping: 25 });
  const rotateY = useSpring(useTransform(mouseX, [-300, 300], [-6, 6]), { stiffness: 120, damping: 25 });

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    mouseX.set(e.clientX - centerX);
    mouseY.set(e.clientY - centerY);
  }

  function handleMouseLeave() {
    mouseX.set(0);
    mouseY.set(0);
  }

  return (
    <main
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative flex min-h-svh flex-1 items-center justify-center overflow-hidden bg-[#050811] px-6 py-12 text-slate-100 selection:bg-sky-500/20"
    >
      <Glass3DBackdrop />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_minmax(380px,440px)] lg:gap-16 relative z-10">
        
        {/* Left Side: Product Story */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
          className="order-2 lg:order-1"
        >
          <ProductStory />
        </motion.div>

        {/* Right Side: Apple Stealth Form Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
          className="order-1 lg:order-2 perspective-1000"
        >
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#090e1a]/70 p-8 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-2xl transition-all duration-300 hover:border-white/20">
            <div className="relative z-10">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] font-mono text-sky-300 mb-2">
                    <Lock className="w-3 h-3 text-sky-400" />
                    <span>Secure Sign In</span>
                  </div>
                  <h2 className="font-heading text-2xl font-extrabold tracking-tight text-slate-100">
                    Welcome back
                  </h2>
                </div>

                <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-sky-400 shadow-inner">
                  <Sparkles className="w-5 h-5 text-sky-400" />
                </div>
              </div>

              <p className="mb-6 text-sm text-slate-400 leading-relaxed">
                Sign in to access your financial datasets and audit trails.
              </p>

              <AuthForm mode="login" />

              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  Bank-grade RLS Security
                </span>
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-1 font-semibold text-sky-400 hover:text-sky-300 transition-colors"
                >
                  Create account
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          </div>

          <p className="mt-4 px-2 text-center text-xs leading-relaxed text-slate-400">
            A copilot, not an autonomous accountant. Every change is verified and signed off by a person.
          </p>
        </motion.div>

      </div>

      <footer className="absolute inset-x-0 bottom-0 px-6 py-4 text-center text-xs text-slate-400 z-10">
        <Link className="transition-colors hover:text-slate-200" href="/signup">
          Don&rsquo;t have an account? <span className="text-sky-400 font-semibold underline">Register now</span>
        </Link>
      </footer>
    </main>
  );
}

function Glass3DBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-32 -top-32 h-[42rem] w-[42rem] rounded-full bg-sky-500/10 blur-[130px]" />
      <div className="absolute -bottom-48 -right-32 h-[46rem] w-[46rem] rounded-full bg-indigo-500/10 blur-[150px]" />
      <div
        className="absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, black 20%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 60% at 50% 50%, black 20%, transparent 80%)',
        }}
      />
    </div>
  );
}


