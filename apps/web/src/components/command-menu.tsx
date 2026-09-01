'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Sparkles, FileSpreadsheet, Building2, Activity, ArrowRight } from 'lucide-react';

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = (command: () => void) => {
    setOpen(false);
    command();
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden md:flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 bg-slate-900/70 border border-slate-800 rounded-lg hover:border-cyan-500/40 hover:bg-slate-800/60 transition-all duration-200 group shadow-sm"
      >
        <Sparkles className="w-3.5 h-3.5 text-cyan-400 group-hover:animate-pulse" />
        <span>Quick Command Palette...</span>
        <kbd className="ml-2 font-mono text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">
          ⌘K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search DataEngine..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Core Actions">
            <CommandItem onSelect={() => runCommand(() => router.push('/app'))}>
              <FileSpreadsheet className="h-4 w-4 text-cyan-400" />
              <span>Categorise New File</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push('/app/workspaces'))}>
              <Building2 className="h-4 w-4 text-emerald-400" />
              <span>View Client Workspaces</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push('/app/audit'))}>
              <Activity className="h-4 w-4 text-purple-400" />
              <span>View Engine Activity & Audit Logs</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
