'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion, useMotionValue, useTransform, useSpring } from 'framer-motion';
import { AuthForm } from '@/components/auth-form';
import { ProductStory } from '@/components/product-story';
import { Shield, Sparkles, Lock, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  // Interactive 3D Card Tilt Effects
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const rotateX = useSpring(useTransform(mouseY, [-300, 300], [10, -10]), { stiffness: 150, damping: 20 });
  const rotateY = useSpring(useTransform(mouseX, [-300, 300], [-10, 10]), { stiffness: 150, damping: 20 });

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
      className="relative flex min-h-svh flex-1 items-center justify-center overflow-hidden bg-slate-950 px-6 py-12 text-slate-100 selection:bg-cyan-500/30"
    >
      {/* Dynamic Ambient Mesh Backdrop */}
      <Glass3DBackdrop />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_minmax(380px,440px)] lg:gap-16 relative z-10">
        
        {/* Left Side: Product Story & Interactive Highlights */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="order-2 lg:order-1"
        >
          <ProductStory />
        </motion.div>

        {/* Right Side: Apple Glass 3D Form Card */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
          className="order-1 lg:order-2 perspective-1000"
        >
          {/* Apple Glass Container */}
          <div className="relative overflow-hidden rounded-3xl border border-white/15 bg-slate-900/40 p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-2xl transition-all duration-300 hover:border-cyan-400/40 hover:shadow-[0_20px_60px_rgba(6,182,212,0.25)]">
            
            {/* Ambient Glass Reflections */}
            <div className="absolute -left-20 -top-20 h-48 w-48 rounded-full bg-cyan-500/20 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-20 -right-20 h-48 w-48 rounded-full bg-indigo-500/20 blur-3xl pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent opacity-40 pointer-events-none" />

            <div className="relative z-10">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-950/80 border border-cyan-500/30 text-[11px] font-semibold text-cyan-300 mb-2">
                    <Lock className="w-3 h-3 text-cyan-400" />
                    <span>Secure Sign In</span>
                  </div>
                  <h2 className="font-heading text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-slate-100 via-cyan-100 to-teal-200">
                    Welcome back
                  </h2>
                </div>

                <div className="p-3 rounded-2xl bg-cyan-950/60 border border-cyan-500/30 text-cyan-400 shadow-inner">
                  <Sparkles className="w-6 h-6 text-cyan-400 animate-pulse" />
                </div>
              </div>

              <p className="mb-6 text-sm text-slate-400 leading-relaxed">
                Sign in to your client workspaces & AI financial cleaning pipeline.
              </p>

              <AuthForm mode="login" />

              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  Bank-grade RLS Security
                </span>
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-1 font-medium text-cyan-400 hover:text-cyan-300 transition-colors"
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

      {/* Footer */}
      <footer className="absolute inset-x-0 bottom-0 px-6 py-4 text-center text-xs text-slate-400 z-10">
        <Link className="transition-colors hover:text-slate-200" href="/signup">
          Don&rsquo;t have an account? <span className="text-cyan-400 font-semibold underline">Register now</span>
        </Link>
      </footer>
    </main>
  );
}

/**
 * 3D Ambient Mesh Backdrop
 */
function Glass3DBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* Floating Glowing Orbs */}
      <motion.div
        animate={{
          scale: [1, 1.2, 1],
          opacity: [0.15, 0.25, 0.15],
          x: [0, 30, 0],
          y: [0, -30, 0],
        }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -left-32 -top-32 h-[42rem] w-[42rem] rounded-full bg-gradient-to-br from-cyan-500/30 to-teal-500/10 blur-[120px]"
      />
      <motion.div
        animate={{
          scale: [1, 1.15, 1],
          opacity: [0.12, 0.22, 0.12],
          x: [0, -40, 0],
          y: [0, 40, 0],
        }}
        transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -bottom-48 -right-32 h-[46rem] w-[46rem] rounded-full bg-gradient-to-tr from-indigo-500/30 to-purple-500/10 blur-[140px]"
      />

      {/* 3D Perspective Grid */}
      <div
        className="absolute inset-0 opacity-[0.25]"
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

